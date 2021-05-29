import * as AWS from "aws-sdk";
const { v4: uuidv4 } = require('uuid');
const util = require('util');
const dynamoDB: AWS.DynamoDB.DocumentClient = new AWS.DynamoDB.DocumentClient();
import { Context, Callback } from 'aws-lambda';

exports.handler = async (event: any, context: Context, callback: Callback) => {

    const accounts: any = await dynamoDB.query(
        {
            ExpressionAttributeValues: {":status_created": "CREATED"},
            KeyConditionExpression: "account_status = :status_created",
            TableName: 'account',
            IndexName: 'account_status',
            Select: 'COUNT',
        }
    ).promise();

    const vending_ceiling = parseInt(<string>process.env['VENDING_CEILING']);
    let accounts_to_vend = vending_ceiling - accounts['Count'];

    let account_vending_list = [];

    for (let i = 0; i < accounts_to_vend; ++i) {
        const random_suffix = uuidv4().split('-')[0];
        const account_email = `superwerker-aws-test+${random_suffix}@superluminar.io`;
        const account_name = util.format('ovm-%s', random_suffix);

        const account_to_create = {
            'account_name': account_name,
            'account_email': account_email,
        };
        account_vending_list.push(account_to_create);
    }

    callback(null, account_vending_list)
}