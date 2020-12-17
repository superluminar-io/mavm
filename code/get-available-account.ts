import * as AWS from "aws-sdk";
import * as util from "util";

exports.handler = async (event: any, context: any, callback: any) => {

    const dynamoDB: AWS.DynamoDB = new AWS.DynamoDB();
    const accounts: any = await dynamoDB.scan({
            ExpressionAttributeValues: {":status":{"S": "CREATED"}},
            FilterExpression: "account_status=:status",
            Limit: 1,
            TableName: 'account'
        }
    ).promise();

    const account: any = accounts['Items'][0];
    const accountId = account['account_id']['S'];

    return {
        'account_id': accountId,
        'cross_account_role': util.format('arn:....%s...', accountId),
    };
}