import * as AWS from "aws-sdk";
const { v4: uuidv4 } = require('uuid');
const util = require('util');
const dynamoDB: AWS.DynamoDB.DocumentClient = new AWS.DynamoDB.DocumentClient();
const sqs: AWS.SQS = new AWS.SQS();

exports.handler = async (event: any, context: any, callback: any) => {

    const accounts: any = await dynamoDB.query(
        {
            ExpressionAttributeValues: {":status_created": "CREATED"}, // actually it would be better to check for TO_CREATE status as well
            KeyConditionExpression: "account_status = :status_created",
            TableName: 'account',
            IndexName: 'account_status',
            Select: 'COUNT',
        }
    ).promise();

    const vending_ceiling = 10;
    let accounts_to_vend = vending_ceiling - accounts['Count'];

    for (let i = 0; i < accounts_to_vend; ++i) {
        const random_suffix = uuidv4().split('-')[0];
        const account_email = `superwerker-aws-test+${random_suffix}@superluminar.io`;
        const account_name = util.format('ovm-%s', random_suffix);

        const account_to_create = {
            'account_name': account_name,
            'account_email': account_email,
            'account_status': 'TO_CREATE',
        };

        await dynamoDB.put(
            {
                TableName: 'account',
                Item: account_to_create
            }
        ).promise();
        await sqs.sendMessage(
            {
                MessageBody: JSON.stringify(account_to_create),
                QueueUrl: <string>process.env['QUEUE_URL'],
            }
        ).promise();
        console.log('submitted to account creation queue:' + JSON.stringify(account_to_create));
    }
}