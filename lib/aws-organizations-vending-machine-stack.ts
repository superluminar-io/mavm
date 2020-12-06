import * as cdk from '@aws-cdk/core';
import {CfnResource} from '@aws-cdk/core';
import {StateMachine, StateMachineType} from '@aws-cdk/aws-stepfunctions';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';
import * as cws from '@aws-cdk/aws-synthetics';
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
        })

        let triggerAccountCreationFunction = new lambda.NodejsFunction(this, 'SubmitLambda', {
            entry: 'code/start-canary.ts',
            environment: {
                CANARY_NAME: canary.canaryName
            }
        });
        triggerAccountCreationFunction.addToRolePolicy(new PolicyStatement(
            {
                resources: ['*'],
                actions: ['synthetics:StartCanary'],
            }
        ))
        const createAccountStep = new tasks.LambdaInvoke(this, 'Submit Job', {
            lambdaFunction: triggerAccountCreationFunction,
            outputPath: '$.Payload',
        });

        const stateMachine = new StateMachine(
            this,
            'StateMachine',
            {
                definition: createAccountStep,
                stateMachineType: StateMachineType.EXPRESS,
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
