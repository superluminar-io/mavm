import * as cdk from '@aws-cdk/core';
import {ApiToStateMachine} from "./api-to-state-machine";
import {StateMachine} from '@aws-cdk/aws-stepfunctions';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as lambda from '@aws-cdk/aws-lambda-nodejs';

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
                definition: submitJob
            }
        )

        // The code that defines your stack goes here
        new ApiToStateMachine(this, "Api", {
            stateMachine: stateMachine
        })
    }
}
