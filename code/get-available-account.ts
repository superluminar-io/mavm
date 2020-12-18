import * as AWS from "aws-sdk";
import * as util from "util";

exports.handler = async (event: any, context: any, callback: any) => {

    const dynamoDB: AWS.DynamoDB.DocumentClient = new AWS.DynamoDB.DocumentClient();
    const accounts: any = await dynamoDB.query(
        {
            ExpressionAttributeValues: {":status": "CREATED"},
            KeyConditionExpression: "account_status = :status",
            Limit: 1,
            TableName: 'account',
            IndexName: 'account_status',
        }
    ).promise();

    if (accounts['Items'].length === 0) {
        return {
            statusCode: '503',
            body: JSON.stringify({
                'errorMessage': 'vending machine out of AWS accounts, please try again later.'
            }),
            isBase64Encoded: false,
            headers: {
                "Content-Type": "application/json"
            }
        }
    }

    const account: any = accounts['Items'][0];
    const accountName = account['account_name'];
    const accountId = account['account_id'];

    // avoid race conditions:
    // throw an exception when the status has been changed since the last query
    // probably meaning that another request already vended the account
    await dynamoDB.update({
        TableName: 'account',
        Key: {
            account_name: accountName
        },
        UpdateExpression: "SET account_status = :new_status",
        ConditionExpression: "account_status = :existing_status",
        ExpressionAttributeValues: {
            ":new_status": "VENDED",
            ":existing_status": "CREATED",
        },
    }).promise();

    return {
        'account_id': accountId,
        'cross_account_role': util.format('arn:....%s...', accountId),
    };
}