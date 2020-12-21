import * as cdk from '@aws-cdk/core';
import * as lambda_core from '@aws-cdk/aws-lambda';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';
import * as cws from '@aws-cdk/aws-synthetics';
import * as sqs from '@aws-cdk/aws-sqs';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import * as httpapi from '@aws-cdk/aws-apigatewayv2';
import * as httpapiint from '@aws-cdk/aws-apigatewayv2-integrations';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';
import * as lambdaeventsources from '@aws-cdk/aws-lambda-event-sources';
import * as sfn from '@aws-cdk/aws-stepfunctions';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';


import {PolicyStatement} from "@aws-cdk/aws-iam";
import * as path from "path";
import * as fs from "fs";

export class AwsOrganizationsVendingMachineStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const vendingCeiling = new cdk.CfnParameter(this, "VendingCeiling", {
            type: "String",
            description: "Number of AWS accounts to be made ready for vending.",
            default: 10
        });
        const invoiceEmail = new cdk.CfnParameter(this, "InvoiceEmail", {
            type: "String",
            description: "email address to send invoices to.",
        });
        const invoiceCurrency = new cdk.CfnParameter(this, "InvoiceCurrency", {
            type: "String",
            description: "Currency for billing/invoice.",
        });

        const accountCreationQueue = new sqs.Queue(this, 'AccountCreationQueue', {
            deadLetterQueue: {
                queue: new sqs.Queue(this, 'AccountCreationDLQueue'),
                maxReceiveCount: 5,
            }
        });

        const canary = new cws.Canary(this, 'CreateAccount', {
            runtime: new cws.Runtime('syn-nodejs-2.2'),
            test: cws.Test.custom({
                code: cws.Code.fromInline(fs.readFileSync(path.join(__dirname, '../code/create.js'), {encoding: "utf-8"})),
                handler: 'index.handler',
            }),
            startAfterCreation: true,

            // start it regularly, this actually fakes a "watchdog" / "angel" process which keeps account creation running
            schedule: cws.Schedule.expression('rate(1 hour)'),
        });

        canary.role.addToPrincipalPolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['secretsmanager:GetSecretValue', 'ssm:*Parameter*', 'sqs:*', 's3:*', 'transcribe:*', 'dynamodb:*'], // TODO: least privilege
            }
        ));

        // work around https://github.com/aws/aws-cdk/pull/11865
        const cfnCanary = canary.node.defaultChild as cws.CfnCanary;
        cfnCanary.addOverride('Properties.RunConfig.EnvironmentVariables', {
            "PRINCIPAL": process.env.CDK_DEFAULT_ACCOUNT,
            "QUEUE_URL": accountCreationQueue.queueUrl,
            INVOICE_CURRENCY: invoiceCurrency.valueAsString,
            INVOICE_EMAIL: invoiceEmail.valueAsString,

        });
        cfnCanary.addOverride('Properties.RunConfig.TimeoutInSeconds', 600); // delete me after https://github.com/aws/aws-cdk/pull/11865 can be used

        const table = new dynamodb.Table(this, "AccountsTable", {
            tableName: 'account', // don't hardcode once env can be passed to canary
            partitionKey: {
                name: 'account_name',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            stream: dynamodb.StreamViewType.NEW_IMAGE,
        });
        table.addGlobalSecondaryIndex({
            indexName: "account_status",
            partitionKey: {
                name: 'account_status',
                type: dynamodb.AttributeType.STRING,
            },
        });

        const api = new httpapi.HttpApi(this, "OrgVendingApi");

        const getAvailableAccountFunction = new lambda.NodejsFunction(this, 'GetAvailableAccountFunction', {
            entry: 'code/get-available-account.ts',
        });
        getAvailableAccountFunction.addToRolePolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['dynamodb:*'], // TODO: least privilege
            }
        ));

        const vendNewAccountsFunction = new lambda.NodejsFunction(this, 'VendNewAccountsFunction', {
            entry: 'code/vend-new-accounts.ts',
            environment: {
                QUEUE_URL: accountCreationQueue.queueUrl,
                VENDING_CEILING: vendingCeiling.valueAsString,
            }
        });
        vendNewAccountsFunction.addToRolePolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['dynamodb:*', 'states:*', 'sqs:sendMessage'], // TODO: least privilege
            }
        ));
        new events.Rule(this, 'Rule', {
            schedule: events.Schedule.expression('rate(' + vendingCeiling.valueAsString + ' hours)'),
            targets: [
                new targets.LambdaFunction(vendNewAccountsFunction)
            ]
        });

        api.addRoutes({
            path: '/vend',
            methods: [ httpapi.HttpMethod.GET ],
            integration: new httpapiint.LambdaProxyIntegration({
                handler: getAvailableAccountFunction,
            }),
        });

        const accountDeletionQueue = new sqs.Queue(this, 'AccountDeletionQueue', {
            deadLetterQueue: {
                queue: new sqs.Queue(this, 'AccountDeletionDLQueue'),
                maxReceiveCount: 5,
            }
        });

        const accountDeletionFunction = new cws.Canary(this, 'AccountDeletionFunction', {
            runtime: new cws.Runtime('syn-nodejs-2.2'),
            test: cws.Test.custom({
                code: cws.Code.fromInline(fs.readFileSync(path.join(__dirname, '../code/close-account.js'), {encoding: "utf-8"})),
                handler: 'index.handler',
            }),
            startAfterCreation: true,

            // start it regularly, this actually fakes a "watchdog" / "angel" process which keeps account creation running
            schedule: cws.Schedule.expression('rate(1 hour)'),
        });
        accountDeletionFunction.role.addToPrincipalPolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['secretsmanager:GetSecretValue', 'dynamodb:*', 'sqs:*'], // TODO: least privilege
            }
        ));
        // work around https://github.com/aws/aws-cdk/pull/11865
        const cfnAccountDeletionFunction = accountDeletionFunction.node.defaultChild as cws.CfnCanary;
        cfnAccountDeletionFunction.addOverride('Properties.RunConfig.EnvironmentVariables', {
            QUEUE_URL: accountDeletionQueue.queueUrl,

        });
        cfnAccountDeletionFunction.addOverride('Properties.RunConfig.TimeoutInSeconds', 600); // delete me after https://github.com/aws/aws-cdk/pull/11865 can be used

        const waitStep = new sfn.Wait(this, 'WaitForAccountDeletion', {
            time: sfn.WaitTime.duration(cdk.Duration.days(1)) // close vended account after one day
        });
        const queueAccountDeletionStep = new tasks.SqsSendMessage(this, 'QueueAccountDeletionStep', {
            messageBody: sfn.TaskInput.fromDataAt('$'),
            queue: accountDeletionQueue,
        });

        const accountDeletionStateMachine = new sfn.StateMachine(
            this,
            'AccountDeletionStateMachine',
            {
                definition: waitStep
                    .next(queueAccountDeletionStep)
                ,
            }
        );

        const queueAccountDeletionFunction = new lambda.NodejsFunction(this, 'QueueActionDeletionFunction', {
            entry: 'code/queue-account-deletion.ts',
            environment: {
                ACCOUNT_CLOSE_STATE_MACHINE_ARN: accountDeletionStateMachine.stateMachineArn
            }
        });
        queueAccountDeletionFunction.addToRolePolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['states:*'], // TODO: least privilege
            }
        ));
        queueAccountDeletionFunction.addEventSource(new lambdaeventsources.DynamoEventSource(table, {
            startingPosition: lambda_core.StartingPosition.TRIM_HORIZON,
        }));


    }
}
