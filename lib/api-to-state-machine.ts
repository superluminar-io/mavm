import {Construct} from '@aws-cdk/core';
import {StateMachine} from '@aws-cdk/aws-stepfunctions';
import {Role, ServicePrincipal} from '@aws-cdk/aws-iam';
import {
    AwsIntegration,
    EmptyModel,
    PassthroughBehavior,
    RestApi
} from '@aws-cdk/aws-apigateway';

export interface ApiToStateMachineProps {
    stateMachine: StateMachine
}

export class ApiToStateMachine extends Construct {
    constructor(scope: Construct, id: string, props: ApiToStateMachineProps) {
        super(scope, id);

        // Create a role for API Gateway
        const apiRole = new Role(this, `${id}Role`, {
            roleName: `${id}Role`,
            assumedBy: new ServicePrincipal('apigateway.amazonaws.com')
        });

        // Grand role permissions to execute api
        props.stateMachine.grantStartExecution(apiRole);

        // Create api with resource
        const api = new RestApi(scope, `${id}RestApi`);
        const resource = api.root.addResource('execute-state-machine');

        // Model for response
        const methodProps = {
            methodResponses: [
                {
                    statusCode: '200',
                    responseModels: {'application/json': new EmptyModel()}
                }]
        }

        // Putting state machine arn in request transformation and treting body of request as body for state machine
        const requestTemplate = {
            'application/json': JSON.stringify({
                    stateMachineArn: props.stateMachine.stateMachineArn,
                    input: "$util.escapeJavaScript($input.json('$'))"
                }
            )
        }

        // Transformation of response
        const integrationResponse = [
            {
                selectionPattern: '200',
                statusCode: '200',
                // Consider hiding execution ARN for security reasons.
                responseTemplates: {
                    'application/json': "$input.json('$')"
                }
            }
        ];

        // Defining SF integration
        const integration = new AwsIntegration({
            service: 'states',
            action: 'StartExecution',
            options: {
                credentialsRole: apiRole,
                requestTemplates: requestTemplate,
                passthroughBehavior: PassthroughBehavior.NEVER,
                integrationResponses: integrationResponse
            }
        });

        // Add method on which SF will be executed
        resource.addMethod('GET', integration, methodProps);
    }
}