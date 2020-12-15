import * as cdk from '@aws-cdk/core';
import {CfnResource} from '@aws-cdk/core';
import * as sfn from '@aws-cdk/aws-stepfunctions';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';
import * as cws from '@aws-cdk/aws-synthetics';
import * as sqs from '@aws-cdk/aws-sqs';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import {BillingMode} from '@aws-cdk/aws-dynamodb';

import {PolicyStatement, Role, ServicePrincipal} from "@aws-cdk/aws-iam";
import * as path from "path";
import * as fs from "fs";

export class AwsOrganizationsVendingMachineStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const canary = new cws.Canary(this, 'CreateAccount', {
            runtime: new cws.Runtime('syn-nodejs-2.2'),
            test: cws.Test.custom({
                code: cws.Code.fromInline(fs.readFileSync(path.join(__dirname, '../code/create.js'), {encoding: "utf-8"})),
                handler: 'index.handler',
            }),
            startAfterCreation: false,
            schedule: cws.Schedule.once(),
        });

        canary.role.addToPrincipalPolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['secretsmanager:GetSecretValue', 'ssm:*Parameter*', 'sqs:*', 's3:*', 'transcribe:*', 'dynamodb:*'], // TODO: least privilege
            }
        ));

        let genIdFunction = new lambda.NodejsFunction(this, 'GenIdFunction', {
            entry: 'code/gen-id.ts',
        });
        const genIdStep = new tasks.LambdaInvoke(this, 'GenIdStep', {
            lambdaFunction: genIdFunction,
            resultPath: '$.genId',
        });

        const table = new dynamodb.Table(this, "AccountsTable", {
            tableName: 'account', // don't hardcode once env can be passed to canary
            partitionKey: {
                name: 'account_name',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: BillingMode.PAY_PER_REQUEST,
        });

        const writeAccountDataStep = new tasks.DynamoPutItem(this, 'WriteAccountDataStep', {
            item: {
                account_name:  tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.accountName')),
                account_email: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.accountEmail')),
            },
            table: table,
            inputPath: '$.genId.Payload',
            resultPath: 'DISCARD',
        });

        const accountCreationQueue = new sqs.Queue(this, 'AccountCreationQueue', {
            queueName: 'accountCreationQueue2', // TODO: don't hardcode once we can pass this via env to the canary
        });
        const submitAccountStep = new tasks.SqsSendMessage(this, 'SubmitAccountStep', {
            messageBody: sfn.TaskInput.fromDataAt('$.genId.Payload'),
            queue: accountCreationQueue,
            resultPath: 'DISCARD',
        });

        let startAccountCreationFunction = new lambda.NodejsFunction(this, 'StartAccountCreationFunction', {
            entry: 'code/start-canary.ts',
            environment: {
                CANARY_NAME: canary.canaryName
            }
        });
        startAccountCreationFunction.addToRolePolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['synthetics:StartCanary'],
            }
        ))
        const startAccountCreationStep = new tasks.LambdaInvoke(this, 'StartAccountCreationStep', {
            lambdaFunction: startAccountCreationFunction,
        });

        const stateMachine = new sfn.StateMachine(
            this,
            'StateMachine',
            {
                definition: genIdStep
                    .next(writeAccountDataStep)
                    .next(submitAccountStep)
                    .next(startAccountCreationStep)
                ,
                stateMachineType: sfn.StateMachineType.EXPRESS,
            }
        )

        const apiRole = new Role(this, `${id}Role`, {
            assumedBy: new ServicePrincipal('apigateway.amazonaws.com')
        });
        stateMachine.grant(apiRole, 'states:StartSyncExecution')

        this.templateOptions.transforms = ['AWS::Serverless-2016-10-31'];
        new CfnResource(this, 'HttpApi', {
            type: "AWS::Serverless::HttpApi",
            properties: {
                DefinitionBody: {
                    "openapi": "3.0.1",
                    "info": {
                        "title": "AwsOrganizationsVendingMachine",
                        "version": "2020-11-06 15:32:29UTC"
                    },
                    "paths": {
                        "/": {
                            "post": {
                                "responses": {
                                    "default": {
                                        "description": "Default response for POST /"
                                    }
                                },
                                "x-amazon-apigateway-integration": {
                                    "integrationSubtype": "StepFunctions-StartSyncExecution",
                                    "credentials": apiRole.roleArn,
                                    "requestParameters": {
                                        "StateMachineArn": stateMachine.stateMachineArn,
                                    },
                                    "payloadFormatVersion": "1.0",
                                    "type": "aws_proxy",
                                    "connectionType": "INTERNET"
                                }
                            }
                        }
                    },
                    "x-amazon-apigateway-importexport-version": "1.0"
                }
            }
        })
    }
}
