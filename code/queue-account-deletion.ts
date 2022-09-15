import * as AWS from 'aws-sdk'
const sfn: AWS.StepFunctions = new AWS.StepFunctions()
import { DynamoDBStreamEvent, DynamoDBStreamHandler } from 'aws-lambda'

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  for (let record of event.Records) {
    if (record.eventName === 'MODIFY' && record.dynamodb!.NewImage!['account_status']['S'] === 'VENDED') {
      // schedule account deletion via step function
      await sfn
        .startExecution({
          stateMachineArn: <string>process.env['ACCOUNT_CLOSE_STATE_MACHINE_ARN'],
          input: JSON.stringify({
            account_name: record.dynamodb!.NewImage!['account_name']['S'],
            account_email: record.dynamodb!.NewImage!['account_email']['S'],
          }),
        })
        .promise()
    }
  }
}
