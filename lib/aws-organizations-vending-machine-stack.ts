import * as cdk from 'aws-cdk-lib';
import {
    aws_apigateway as restapi,
    aws_codebuild as codebuild,
    aws_dynamodb as dynamodb,
    aws_events as events,
    aws_events_targets as events_targets,
    aws_iam as iam,
    aws_lambda as lambda,
    aws_lambda_event_sources as lambdaeventsources,
    aws_lambda_nodejs as lambda_nodejs,
    aws_logs,
    aws_route53,
    aws_s3 as s3,
    aws_s3_assets as s3_assets,
    aws_s3_deployment as s3deploy,
    aws_s3_notifications,
    aws_ses,
    aws_ses_actions,
    aws_sqs as sqs,
    aws_stepfunctions as sfn,
    aws_stepfunctions_tasks as tasks,
    Stack
} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as httpapi from '@aws-cdk/aws-apigatewayv2-alpha';
import * as httpapiint from '@aws-cdk/aws-apigatewayv2-integrations-alpha';

import * as path from "path";
import {AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId} from "aws-cdk-lib/custom-resources";
import {Bucket} from 'aws-cdk-lib/aws-s3';
import {Artifacts} from 'aws-cdk-lib/aws-codebuild';
import {NodejsFunction} from 'aws-cdk-lib/aws-lambda-nodejs';

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

        const managementAccountRootEmailDnsHostedZoneId = new cdk.CfnParameter(this, "ManagementAccountRootEmailDnsHostedZoneId", {
            type: "String",
        });

        const managementAccountRootEmailDnsHostedZoneName = new cdk.CfnParameter(this, "ManagementAccountRootEmailDnsHostedZoneName", {
            type: "String",
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
            {methodResponses: [{statusCode: "200"}]}
        );

        const createAccountCodeAsset = new s3_assets.Asset(this, 'CreateAccountCodeAsset', {
            path: path.join(__dirname, '../code/create-account'),
            exclude: [
                'node_modules',
                '.git',
                'cdk.out',
                '*.jpg'
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

        const bucketForCrossAccountRoleCfnTemplate = new s3.Bucket(this, 'BucketForCrossAccountRoleCfnTemplate', {
            publicReadAccess: true,
        });

        const deployment = new s3deploy.BucketDeployment(this, 'DeployCrossAccountRoleCfnTemplate', {
            sources: [
                s3deploy.Source.asset(
                    path.join(__dirname, '.'), {
                        exclude: ['**', '!crossaccountrole.yaml']
                    }
                )
            ],
            destinationBucket: bucketForCrossAccountRoleCfnTemplate,
        });

        const managementAccountRootMailEmailVerificationQueue = new sqs.Queue(this, 'ManagementAccountRootMailEmailVerificationQueue', {
            retentionPeriod: cdk.Duration.minutes(1),
        });

        const artifactBucket = new Bucket(this, `create-accounts-artifacts`, {});

        const createAccountCodeProject = new codebuild.Project(this, 'CreateAccountCodeProject', {
            source: codebuild.Source.s3({
                bucket: createAccountCodeAsset.bucket,
                path: createAccountCodeAsset.s3ObjectKey,
            }),
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
            },
            environmentVariables: {
                PRINCIPAL: {value: process.env.CDK_DEFAULT_ACCOUNT},
                INVOICE_CURRENCY: {value: invoiceCurrency.valueAsString},
                INVOICE_EMAIL: {value: invoiceEmail.valueAsString},
                QUEUE_URL_3D_SECURE: {value: creditCard3SecureQueue.queueUrl},
                QUEUE_URL_MAIL_VERIFICATION: {value: managementAccountRootMailEmailVerificationQueue.queueUrl},
                CONNECT_INSTANCE_ID: {value: connectInstanceId.valueAsString},
                BUCKET_FOR_TRANSCRIBE: {value: bucketForTranscribe.bucketName},
                BUCKET_FOR_CROSS_ACCOUNT_ROLE_CFN_TEMPLATE: {value: bucketForCrossAccountRoleCfnTemplate.bucketName},
            },
            artifacts: Artifacts.s3({
                bucket: artifactBucket,
                packageZip: false,
                includeBuildId: true,
            }),

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
                ACCOUNT_ROOT_EMAIL_PATTERN: 'root+%s@' + managementAccountRootEmailDnsHostedZoneName.valueAsString,
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
            methods: [httpapi.HttpMethod.GET],
            integration: new httpapiint.HttpLambdaIntegration('GetAvailableAccountHandler', getAvailableAccountFunction),
        });

        //
        // CleanUp StepFunction
        //
        const getVendedAccountsToCleanUp = new NodejsFunction(this, 'GetVendedAccountsToCleanUpFunction', {
            entry: 'code/get-vended-accounts-to-cleanup.ts',
        });
        table.grantReadData(getVendedAccountsToCleanUp);

        const closeAccountCodeAsset = new s3_assets.Asset(this, 'CloseAccountCodeAsset', {
            path: path.join(__dirname, '../code/close-account'),
            exclude: [
                'node_modules',
                '.git',
                'cdk.out'
            ],
        });
        const closeAccountCodeProject = new codebuild.Project(this, 'CloseAccountCodeProject', {
            source: codebuild.Source.s3({
                bucket: closeAccountCodeAsset.bucket,
                path: closeAccountCodeAsset.s3ObjectKey,
            }),
            environment: {
                buildImage: codebuild.LinuxBuildImage.STANDARD_5_0,
            },
            artifacts: Artifacts.s3({
                bucket: artifactBucket,
                packageZip: false,
                includeBuildId: true,
            }),

        });
        closeAccountCodeProject.role?.addToPrincipalPolicy(new iam.PolicyStatement(
          {
              resources: ['*'],
              actions: ['secretsmanager:GetSecretValue', 'ssm:*Parameter*', 'sqs:*', 's3:*', 'dynamodb:*', 'sts:*', 'connect:*', 'transcribe:*'], // TODO: least privilege
          }
        ));

        const closeRootAccountTask = new tasks.CodeBuildStartBuild(this, 'CloseRootAccount', {
            project: closeAccountCodeProject,
            integrationPattern: sfn.IntegrationPattern.RUN_JOB,
            environmentVariablesOverride: {
                ACCOUNT_NAME: {
                    type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
                    value: sfn.JsonPath.stringAt('$.accountName'),
                },
                ACCOUNT_EMAIL: {
                    type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
                    value: sfn.JsonPath.stringAt('$.accountEmail'),
                },
            },
        });

        new sfn.StateMachine(
          this,
          'CleanUpAccounts',
          {
              definition: new tasks.LambdaInvoke(this, 'GetVendedAccountsToCleanUpTask', {
                  lambdaFunction: getVendedAccountsToCleanUp,
                  outputPath: "$.Payload"
              }).next(
                new sfn.Map(this, 'MapRootAccounts', {
                    maxConcurrency: 4, // to avoid running into rate-limits when closing accounts later in the chain
                }).iterator(new tasks.CallAwsService(this, 'OrganizationsListAccounts', {
                    service: 'organizations',
                    action: 'listAccounts',
                    credentials: {role: sfn.TaskRole.fromRoleArnJsonPath("States.Format('arn:aws:iam::{}:role/OVMCrossAccountRole', $.accountId)")},
                    iamResources: ['*'],
                    resultSelector: {Accounts: sfn.JsonPath.stringAt('$..Accounts[?(@.Status==ACTIVE)]')}, // to ignore already suspended accounts
                    resultPath: sfn.JsonPath.stringAt('$.subAccounts'),
                }).addCatch(new sfn.Pass(this, 'RootAccountIsMissingOrganization').next(closeRootAccountTask), {
                    errors: ["Organizations.AwsOrganizationsNotInUseException"],
                    resultPath: sfn.JsonPath.stringAt("$.error")
                }).addCatch(new sfn.Choice(this, 'IsNotAuthorizedToAssumeOVMCrossAccountRole')
                  .when(sfn.Condition.stringMatches("$.error.Cause", "The role * is not authorized to assume the task state's role, arn:aws:iam::*:role/OVMCrossAccountRole."),
                    closeRootAccountTask)
                  .otherwise(new sfn.Fail(this, "UnknownFailure")), {
                    errors: ["States.TaskFailed"],
                    resultPath: sfn.JsonPath.stringAt("$.error")
                })
                  .next(new sfn.Choice(this, 'HasSubAccounts?')
                    .when(sfn.Condition.isPresent(sfn.JsonPath.stringAt("$.subAccounts.Accounts[1]")), // to check if there are more than the root account in the array
                      new sfn.Map(this, 'MapSubAccounts', {
                          maxConcurrency: 1, // to avoid running into rate-limits on the close account API
                          itemsPath: sfn.JsonPath.stringAt('$.subAccounts.Accounts'),
                          parameters: {
                              subAccountId: sfn.JsonPath.stringAt("$$.Map.Item.Value.Id"),
                              rootAccountId: sfn.JsonPath.stringAt("$.accountId")
                          },
                      }).iterator(
                        new sfn.Choice(this, 'SubAccountIdEqualsRootAccountId?')
                          .when(sfn.Condition.stringEqualsJsonPath(sfn.JsonPath.stringAt('$.rootAccountId'), sfn.JsonPath.stringAt('$.subAccountId')),
                            new sfn.Pass(this, 'SkipRootAccount')
                          )
                          .otherwise(new tasks.CallAwsService(this, 'OrganizationsCloseAccounts', {
                              service: 'organizations',
                              action: 'closeAccount',
                              credentials: {role: sfn.TaskRole.fromRoleArnJsonPath("States.Format('arn:aws:iam::{}:role/OVMCrossAccountRole', $.rootAccountId)")},
                              iamResources: ['*'],
                              parameters: {
                                  AccountId: sfn.JsonPath.stringAt("$.subAccountId")
                              }
                          }).addCatch(new sfn.Pass(this, 'GracefullySkipAccountClosing'), {
                              errors: ["Organizations.TooManyRequestsException", "Organizations.AccountAlreadyClosedException"]
                          }))
                      ))
                    .otherwise(closeRootAccountTask)))
              ),
          }
        );

        //
        //
        //

        const s3bucketForManagementAccountRootMail = new s3.Bucket(this, 'ManagementAccountRootMailBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            lifecycleRules: [
                {
                    expiration: cdk.Duration.days(1),
                },
            ],
        });
        s3bucketForManagementAccountRootMail.addToResourcePolicy(new iam.PolicyStatement(
            {
                resources: [`${s3bucketForManagementAccountRootMail.bucketArn}/*`],
                actions: ['s3:PutObject'],
                principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
                conditions: {
                    'StringEquals': {
                        'aws:Referer': "${AWS::AccountId}",
                    }
                }
            }
        ));

        s3bucketForManagementAccountRootMail.addEventNotification(s3.EventType.OBJECT_CREATED_PUT, new aws_s3_notifications.SqsDestination(managementAccountRootMailEmailVerificationQueue));

        // RootMail setup
        const dnsZoneForManagementAccountRootEmail = aws_route53.HostedZone.fromHostedZoneAttributes(this, 'ManagementAccountRootEmailDnsZone', {
            hostedZoneId: managementAccountRootEmailDnsHostedZoneId.valueAsString,
            zoneName: managementAccountRootEmailDnsHostedZoneName.valueAsString
        });

        new aws_route53.MxRecord(this, "ManagementAccountRootEmailDnsZoneMxRecord", {
            zone: dnsZoneForManagementAccountRootEmail,
            values: [{
                hostName: "inbound-smtp.eu-west-1.amazonaws.com",
                priority: 10
            }],
        });

        const domainName = dnsZoneForManagementAccountRootEmail.zoneName;
        const emailAddress = 'root@' + domainName;
        const managementAccountRootEmailSesRuleset = new aws_ses.ReceiptRuleSet(this, 'ManagementAccountRootEmailSesRuleset', {
            rules: [
                {
                    recipients: [emailAddress],
                    actions: [
                        new aws_ses_actions.S3({
                            bucket: s3bucketForManagementAccountRootMail,
                        }),
                    ],
                },
            ],
        });

        new AwsCustomResource(this, 'ManagementAccountRootEmailSesRulesetEnable', {
            logRetention: aws_logs.RetentionDays.ONE_DAY,
            installLatestAwsSdk: false,
            onCreate: {
                service: 'SES',
                action: 'setActiveReceiptRuleSet',
                parameters: {
                    RuleSetName: managementAccountRootEmailSesRuleset.receiptRuleSetName,
                },
                physicalResourceId: PhysicalResourceId.of('enable-rule-set-on-create'),
            },
            onDelete: {
                service: 'SES',
                action: 'setActiveReceiptRuleSet',
                parameters: {},
                physicalResourceId: PhysicalResourceId.of('disable-rule-set-on-delete'),
            },
            policy: AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['ses:SetActiveReceiptRuleSet'],
                    effect: iam.Effect.ALLOW,
                    resources: ['*'],
                }),
            ]),
        });

        new AwsCustomResource(this, 'ManagementAccountRootEmailSesIdentity', {
            onCreate: {
                service: 'SES',
                action: 'verifyEmailIdentity',
                parameters: {
                    EmailAddress: emailAddress,
                },
                physicalResourceId: PhysicalResourceId.of('ManagementAccountRootEmailSesVerifier'),
            },
            onDelete: {
                service: 'SES',
                action: 'deleteIdentity',
                parameters: {
                    Identity: emailAddress,
                },
            },
            policy: AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['ses:verifyEmailIdentity'],
                    effect: iam.Effect.ALLOW,
                    resources: ['*'],
                }),
            ]),
        });

        const verifyDomainDkim = new AwsCustomResource(this, 'VerifyDomainDkim', {
            onCreate: {
                service: 'SES',
                action: 'verifyDomainDkim',
                parameters: {
                    Domain: domainName,
                },
                physicalResourceId: PhysicalResourceId.of('ManagementAccountRootEmailSesDkimVerifier'),
            },
            onUpdate: {
                service: 'SES',
                action: 'verifyDomainDkim',
                parameters: {
                    Domain: domainName,
                },
                physicalResourceId: PhysicalResourceId.of('ManagementAccountRootEmailSesDkimVerifier'),
            },
            policy: AwsCustomResourcePolicy.fromStatements([
                new iam.PolicyStatement({
                    actions: ['ses:VerifyDomainDkim'],
                    effect: iam.Effect.ALLOW,
                    resources: ['*'],
                }),
            ]),
        });

        [0, 1, 2].forEach((val) => {
            const dkimToken = verifyDomainDkim.getResponseField(`DkimTokens.${val}`);
            const cnameRecord = new aws_route53.CnameRecord(this, 'ManagementAccountRootEmailSesDkimVerifierRecord' + val, {
                zone: dnsZoneForManagementAccountRootEmail,
                recordName: `${dkimToken}._domainkey.${domainName}`,
                domainName: `${dkimToken}.dkim.amazonses.com`,
            });
            cnameRecord.node.addDependency(verifyDomainDkim);
        });

        new cdk.CfnOutput(this, 'BucketForTranscribeOutput', {
            value: bucketForTranscribe.bucketName,
        });
    }
}
