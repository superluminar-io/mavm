import * as cdk from '@aws-cdk/core';
import {ApiToStateMachine} from "./api-to-state-machine";
import {StateMachine, StateMachineType} from '@aws-cdk/aws-stepfunctions';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';
import {Role, ServicePrincipal} from "@aws-cdk/aws-iam";
import {CfnResource} from "@aws-cdk/core";

export class AwsOrganizationsVendingMachineStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        let submitLambda = new lambda.NodejsFunction(this, 'SubmitLambda', {
            entry: 'code/hello.ts'
        });

        const submitJob = new tasks.LambdaInvoke(this, 'Submit Job', {
            lambdaFunction: submitLambda,
            // Lambda's result is in the attribute `Payload`
            outputPath: '$.Payload',
        });

        const stateMachine = new StateMachine(
            this,
            'StateMachine',
            {
                definition: submitJob,
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
