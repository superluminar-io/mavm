import {aws_events_targets, Stack} from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { aws_iam as iam } from 'aws-cdk-lib';
import { aws_s3 as s3 } from 'aws-cdk-lib';
import { aws_sqs as sqs } from 'aws-cdk-lib';
import { aws_events as events } from 'aws-cdk-lib';
import { aws_events_targets as events_targets } from 'aws-cdk-lib';
import { aws_lambda as lambda } from 'aws-cdk-lib';
import { aws_lambda_nodejs as lambda_nodejs } from 'aws-cdk-lib';
import { aws_dynamodb as dynamodb } from 'aws-cdk-lib';
import { aws_apigateway as restapi } from 'aws-cdk-lib';
import * as httpapi from '@aws-cdk/aws-apigatewayv2-alpha';
import { aws_lambda_event_sources as lambdaeventsources } from 'aws-cdk-lib';
import { aws_stepfunctions as sfn } from 'aws-cdk-lib';
import { aws_stepfunctions_tasks as tasks } from 'aws-cdk-lib';
import { aws_codebuild as codebuild } from 'aws-cdk-lib';
import { aws_s3_assets as s3_assets } from 'aws-cdk-lib';
import * as httpapiint from '@aws-cdk/aws-apigatewayv2-integrations-alpha';

import * as path from "path";

export class AwsOrganizationsVendingMachineStack extends Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const invoiceEmail = new cdk.CfnParameter(this, "InvoiceEmail", {
            type: "String",
            description: "email address to send invoices to.",
        });
        const invoiceCurrency = new cdk.CfnParameter(this, "InvoiceCurrency", {
            type: "String",
            description: "Currency for billing/invoice.",
        });

        const connectInstanceId = new cdk.CfnParameter(this, "ConnectInstanceId", {
            type: "String",
            description: "Amazon Connect instance id.",
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

        const createAccountCodeAsset = new s3_assets.Asset(this, 'CreateAccountCodeAsset', {
            path: path.join(__dirname, '../code/create-account'),
            exclude: [
                'node_modules',
                '.git',
                'cdk.out'
            ],
        });

        const bucketForTranscribe = new s3.Bucket(this, 'BucketForTranscribe', {
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(1),
                },
            ],
            removalPolicy: cdk.RemovalPolicy.DESTROY,
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
                CONNECT_INSTANCE_ID: {value: connectInstanceId.valueAsString},
                BUCKET_FOR_TRANSCRIBE: {value: bucketForTranscribe.bucketName},
            }
        });
        createAccountCodeProject.role?.addToPrincipalPolicy(new iam.PolicyStatement(
            {
                resources: ['*'],
                actions: ['secretsmanager:GetSecretValue', 'ssm:*Parameter*', 'sqs:*', 's3:*', 'dynamodb:*', 'sts:*', 'connect:*', 'transcribe:*'], // TODO: least privilege
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

        const WAITING_HOURS_BETWEEN_ACCOUNT_CREATION_CALLS = 2;
        const createAccountStateMachineWaitStep = new sfn.Wait(this, 'CreateAccountStateMachineWaitStep', {
            time: sfn.WaitTime.duration(cdk.Duration.hours(WAITING_HOURS_BETWEEN_ACCOUNT_CREATION_CALLS))
        });

        createAccountStateMachineAccountCreationStep.addCatch(createAccountStateMachineWaitStep);

        const accountNameProviderFunction = new lambda_nodejs.NodejsFunction(this, 'AccountNameProviderFunction', {
            entry: 'code/account-name-provider.ts',
            environment: {
                ACCOUNTS_TO_VEND: (24 / WAITING_HOURS_BETWEEN_ACCOUNT_CREATION_CALLS).toString(),
            },
            timeout: cdk.Duration.minutes(1),
        });
        accountNameProviderFunction.addToRolePolicy(new iam.PolicyStatement(
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

        const createAccountStateMachineRule = new events.Rule(this, 'CreateAccountStateMachineRule', {
            schedule: events.Schedule.rate(cdk.Duration.days(1)),
        });

        createAccountStateMachineRule.addTarget(new events_targets.SfnStateMachine(createAccountStateMachine));

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

        const getAvailableAccountFunction = new lambda_nodejs.NodejsFunction(this, 'GetAvailableAccountFunction', {
            entry: 'code/get-available-account.ts',
        });
        getAvailableAccountFunction.addToRolePolicy(new iam.PolicyStatement(
            {
                resources: ['*'],
                actions: ['dynamodb:*'], // TODO: least privilege
            }
        ));

        api.addRoutes({
            path: '/vend',
            methods: [ httpapi.HttpMethod.GET ],
            integration: new httpapiint.HttpLambdaIntegration('GetAvailableAccountHandler', getAvailableAccountFunction),
        });

        const closeAccountCodeAsset = new s3_assets.Asset(this, 'CloseAccountCodeAsset', {
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
        closeAccountCodeCodeBuild.role?.addToPrincipalPolicy(new iam.PolicyStatement(
            {
                resources: ['*'],
                actions: ['secretsmanager:GetSecretValue', 'dynamodb:*', 'sts:AssumeRole'], // TODO: least privilege
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

        const queueAccountDeletionFunction = new lambda_nodejs.NodejsFunction(this, 'QueueActionDeletionFunction', {
            entry: 'code/queue-account-deletion.ts',
            environment: {
                ACCOUNT_CLOSE_STATE_MACHINE_ARN: accountDeletionStateMachineNew.stateMachineArn
            }
        });
        queueAccountDeletionFunction.addToRolePolicy(new iam.PolicyStatement(
            {
                resources: ['*'],
                actions: ['states:*'], // TODO: least privilege
            }
        ));
        queueAccountDeletionFunction.addEventSource(new lambdaeventsources.DynamoEventSource(table, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        }));

        new cdk.CfnOutput(this, 'BucketForTranscribeOutput', {
            value: bucketForTranscribe.bucketName,
        });
    }
}
