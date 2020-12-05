import {CfnResource, Construct} from '@aws-cdk/core';
import {StateMachine} from '@aws-cdk/aws-stepfunctions';
import {Role, ServicePrincipal} from '@aws-cdk/aws-iam';
import * as httpApi from '@aws-cdk/aws-apigatewayv2';
import {HttpIntegrationType} from '@aws-cdk/aws-apigatewayv2';
import * as sam from '@aws-cdk/aws-sam';

export interface ApiToStateMachineProps {
    stateMachine: StateMachine
}

export class ApiToStateMachine extends Construct {
    constructor(scope: Construct, id: string, props: ApiToStateMachineProps) {
        super(scope, id);

        // Create a role for API Gateway
        const apiRole = new Role(this, `${id}Role`, {
            assumedBy: new ServicePrincipal('apigateway.amazonaws.com')
        });
        props.stateMachine.grant(apiRole, 'states:StartSyncExecution')

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
                                        "StateMachineArn": props.stateMachine.stateMachineArn,
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

        // // Model for response
        // const methodProps = {
        //     methodResponses: [
        //         {
        //             statusCode: '200',
        //             responseModels: {'application/json': new EmptyModel()}
        //         }]
        // }
        //
        // // Putting state machine arn in request transformation and treting body of request as body for state machine
        // const requestTemplate = {
        //     'application/json': JSON.stringify({
        //             stateMachineArn: props.stateMachine.stateMachineArn,
        //             input: "$util.escapeJavaScript($input.json('$'))"
        //         }
        //     )
        // }

        // // Transformation of response
        // const integrationResponse = [
        //     {
        //         selectionPattern: '200',
        //         statusCode: '200',
        //         // Consider hiding execution ARN for security reasons.
        //         responseTemplates: {
        //             'application/json': "$input.json('$')"
        //         }
        //     }
        // ];

        // // Create api with resource
        // const api = new httpApi.HttpApi(scope, `${id}HttpApi`,
        //     {
        //
        //     });
        //
        // // Defining SF integration
        // const integration = new httpApi.CfnIntegration(this, "Sfn", {
        //     integrationSubtype: "StepFunctions-StartSyncExecution",
        //     integrationType: "AWS_PROXY",
        //     credentialsArn: apiRole.roleArn,
        //     apiId: api.httpApiId,
        //     requestParameters: {
        //         Input: "$request.body",
        //         StateMachineArn: props.stateMachine.stateMachineArn
        //     },
        //     payloadFormatVersion: "1.0"
        // });
        //
        // new httpApi.CfnRoute(this, "Route", {
        //     apiId: api.httpApiId,
        //     routeKey: "POST /execute-state-machine",
        //     target: 'integrations' + integration.
        // })
        // //
        // api.addRoutes({
        //     path: '/execute-state-machine',
        //     methods: [ httpApi.HttpMethod.POST ],
        //
        //
        // });
    }
}