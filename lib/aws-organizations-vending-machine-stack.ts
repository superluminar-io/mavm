import * as cdk from '@aws-cdk/core';
import * as lambda_core from '@aws-cdk/aws-lambda';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';
import * as sqs from '@aws-cdk/aws-sqs';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import * as iam from '@aws-cdk/aws-iam';
import * as restapi from '@aws-cdk/aws-apigateway';
import * as httpapi from '@aws-cdk/aws-apigatewayv2';
import * as httpapiint from '@aws-cdk/aws-apigatewayv2-integrations';
import * as lambdaeventsources from '@aws-cdk/aws-lambda-event-sources';
import * as sfn from '@aws-cdk/aws-stepfunctions';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as codebuild from '@aws-cdk/aws-codebuild';
import {Asset} from '@aws-cdk/aws-s3-assets';

import {PolicyStatement} from "@aws-cdk/aws-iam";
import * as path from "path";

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

        const creditCard3SecureQueue = new sqs.Queue(this, 'CreditCard3SecureQueue', {
            retentionPeriod: cdk.Duration.minutes(1),
        });

        const creditCard3SecureQueueRole = new iam.Role(this, "CreditCard3SecureQueueRole", {
            assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
        });

        creditCard3SecureQueueRole.attachInlinePolicy(
            new iam.Policy(this, "SendMessagePolicy", {
                statements: [
                    new iam.PolicyStatement({
                        actions: ["sqs:SendMessage"],
                        effect: iam.Effect.ALLOW,
                        resources: [creditCard3SecureQueue.queueArn],
                    }),
                ],
            })
        );

        const creditCard3SecureQueueApi = new restapi.RestApi(this, "CreditCard3SecureQueueApi", {
            deployOptions: {
                stageName: 'prod',
            },
        });

        const creditCard3SecureQueueApiResource = creditCard3SecureQueueApi.root.addResource("queue");
        creditCard3SecureQueueApiResource.addMethod(
            "GET",
            new restapi.AwsIntegration({
                service: "sqs",
                path: `${cdk.Aws.ACCOUNT_ID}/${creditCard3SecureQueue.queueName}`,
                integrationHttpMethod: "POST",
                options: {
                    credentialsRole: creditCard3SecureQueueRole,
                    passthroughBehavior: restapi.PassthroughBehavior.NEVER,
                    requestParameters: {
                        "integration.request.header.Content-Type": `'application/x-www-form-urlencoded'`,
                    },
                    requestTemplates: {
                        "application/json": `Action=SendMessage&MessageBody=$util.urlEncode("$method.request.querystring.text")`,
                    },
                    integrationResponses: [
                        {
                            statusCode: "200",
                            responseTemplates: {
                                "application/json": `{"done": true}`,
                            },
                        },
                    ],
                },
            }),
            { methodResponses: [{ statusCode: "200" }] }
        );

        const createAccountCodeAsset = new Asset(this, 'CreateAccountCodeAsset', {
            path: path.join(__dirname, '../code/create-account'),
            exclude: [
                'node_modules',
                '.git',
                'cdk.out'
            ],
        });

        const createAccountCodeProject = new codebuild.Project(this, 'CreateAccountCodeProject', {
            source: codebuild.Source.s3({
                bucket: createAccountCodeAsset.bucket,
                path: createAccountCodeAsset.s3ObjectKey,
            }),
            environmentVariables: {
                PRINCIPAL: {value: process.env.CDK_DEFAULT_ACCOUNT },
                INVOICE_CURRENCY: {value: invoiceCurrency.valueAsString},
                INVOICE_EMAIL: {value: invoiceEmail.valueAsString},
                QUEUE_URL_3D_SECURE: {value: creditCard3SecureQueue.queueUrl},
            }
        });
        createAccountCodeProject.role?.addToPrincipalPolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['secretsmanager:GetSecretValue', 'ssm:*Parameter*', 'sqs:*', 's3:*', 'transcribe:*', 'dynamodb:*', 'sts:*'], // TODO: least privilege
            }
        ));

        const createAccountStateMachineAccountCreationStep = new tasks.CodeBuildStartBuild(this, 'CreateAccountStateMachineAccountCreationStep', {
            project: createAccountCodeProject,
            integrationPattern: sfn.IntegrationPattern.RUN_JOB,
            environmentVariablesOverride: {
                ACCOUNT_NAME: {
                    type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
                    value: sfn.JsonPath.stringAt('$.account_name'),
                },
                ACCOUNT_EMAIL: {
                    type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
                    value: sfn.JsonPath.stringAt('$.account_email'),
                },
            },
        });

        const createAccountStateMachineWaitStep = new sfn.Wait(this, 'CreateAccountStateMachineWaitStep', {
            time: sfn.WaitTime.duration(cdk.Duration.minutes(120))
        });

        createAccountStateMachineAccountCreationStep.addCatch(createAccountStateMachineWaitStep);

        const accountNameProviderFunction = new lambda.NodejsFunction(this, 'AccountNameProviderFunction', {
            entry: 'code/account-name-provider.ts',
            environment: {
                VENDING_CEILING: vendingCeiling.valueAsString,
            },
            timeout: cdk.Duration.minutes(1),
        });
        accountNameProviderFunction.addToRolePolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['dynamodb:*'], // TODO: least privilege
            }
        ));

        const createAccountStateMachineAccountNameProviderStep = new tasks.LambdaInvoke(this, 'CreateAccountStateMachineAccountNameProviderStep', {
            lambdaFunction: accountNameProviderFunction,
            resultPath: '$.accountNameProviderStep'
        });

        const createAccountStateMachineMapStep = new sfn.Map(this, 'CreateAccountStateMachineMapStep', {
            inputPath: '$.accountNameProviderStep',
            itemsPath: '$.Payload',
            maxConcurrency: 1,
        });
        createAccountStateMachineMapStep.iterator(createAccountStateMachineAccountCreationStep.next(createAccountStateMachineWaitStep));

        const createAccountStateMachine = new sfn.StateMachine(
            this,
            'CreateAccountStateMachine',
            {
                definition: createAccountStateMachineAccountNameProviderStep
                    .next(createAccountStateMachineMapStep)
            }
        );

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

        api.addRoutes({
            path: '/vend',
            methods: [ httpapi.HttpMethod.GET ],
            integration: new httpapiint.LambdaProxyIntegration({
                handler: getAvailableAccountFunction,
            }),
        });

        const closeAccountCodeAsset = new Asset(this, 'CloseAccountCodeAsset', {
            path: path.join(__dirname, '../code/close-account'),
            exclude: [
                'node_modules',
                '.git',
                'cdk.out'
            ],
        });

        const closeAccountCodeCodeBuild = new codebuild.Project(this, 'AccountDeletionProject', {
            source: codebuild.Source.s3({
                bucket: closeAccountCodeAsset.bucket,
                path: closeAccountCodeAsset.s3ObjectKey,
            }),
        });
        closeAccountCodeCodeBuild.role?.addToPrincipalPolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['secretsmanager:GetSecretValue', 'dynamodb:*'], // TODO: least privilege
            }
        ));

        const accountDeletionViaCodeBuildStep = new tasks.CodeBuildStartBuild(this, 'QueueAccountDeletionViaCodeBuildStep', {
            project: closeAccountCodeCodeBuild,
            integrationPattern: sfn.IntegrationPattern.RUN_JOB,
            environmentVariablesOverride: {
                ACCOUNT_NAME: {
                    type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
                    value: sfn.JsonPath.stringAt('$.account_name'),
                },
                ACCOUNT_EMAIL: {
                    type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
                    value: sfn.JsonPath.stringAt('$.account_email'),
                },
            },
        });
        accountDeletionViaCodeBuildStep.addRetry({
            maxAttempts: 99999999,
            interval: cdk.Duration.hours(12),
            backoffRate: 1.1,
        });

        const waitStepNew = new sfn.Wait(this, 'WaitForAccountDeletionNew', {
            time: sfn.WaitTime.duration(cdk.Duration.days(1)) // close vended account after one day
        });
        const accountDeletionStateMachineNew = new sfn.StateMachine(
            this,
            'AccountDeletionStateMachineNew',
            {
                definition: waitStepNew
                    .next(accountDeletionViaCodeBuildStep),
            }
        );

        const queueAccountDeletionFunction = new lambda.NodejsFunction(this, 'QueueActionDeletionFunction', {
            entry: 'code/queue-account-deletion.ts',
            environment: {
                ACCOUNT_CLOSE_STATE_MACHINE_ARN: accountDeletionStateMachineNew.stateMachineArn
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
