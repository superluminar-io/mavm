import * as cdk from '@aws-cdk/core';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';
import * as cws from '@aws-cdk/aws-synthetics';
import * as sqs from '@aws-cdk/aws-sqs';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import * as httpapi from '@aws-cdk/aws-apigatewayv2';
import * as httpapiint from '@aws-cdk/aws-apigatewayv2-integrations';
import * as events from '@aws-cdk/aws-events';
import * as targets from '@aws-cdk/aws-events-targets';

import {PolicyStatement} from "@aws-cdk/aws-iam";
import * as path from "path";
import * as fs from "fs";

export class AwsOrganizationsVendingMachineStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const accountCreationQueue = new sqs.Queue(this, 'AccountCreationQueue', {
            queueName: 'accountCreationQueue2', // TODO: don't hardcode once we can pass this via env to the canary
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

        });
        cfnCanary.addOverride('Properties.RunConfig.TimeoutInSeconds', 600); // delete me after https://github.com/aws/aws-cdk/pull/11865 can be used

        const table = new dynamodb.Table(this, "AccountsTable", {
            tableName: 'account', // don't hardcode once env can be passed to canary
            partitionKey: {
                name: 'account_name',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
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
            }
        });
        vendNewAccountsFunction.addToRolePolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['dynamodb:*', 'states:*', 'sqs:sendMessage'], // TODO: least privilege
            }
        ));
        new events.Rule(this, 'Rule', {
            schedule: events.Schedule.expression('rate(1 hour)'),
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
    }
}
