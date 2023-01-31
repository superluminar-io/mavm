import * as AWS from "aws-sdk";

exports.handler = async (event: any, context: any, callback: any) => {

  const dynamoDB: AWS.DynamoDB.DocumentClient = new AWS.DynamoDB.DocumentClient();

  const {Items} = await dynamoDB.query(
    {
      ExpressionAttributeValues: {":status": "VENDED", ":one_day_before_now": new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString()},
      KeyConditionExpression: "account_status = :status",
      TableName: 'account',
      IndexName: 'account_status',
      ScanIndexForward: false,
      FilterExpression: "attribute_not_exists(vending_date) or vending_date < :one_day_before_now"
    }
  ).promise()

  if (!Items) {
    return {account_ids: []}
  }

  const accounts: { accountId: string, accountName: string, accountEmail: string }[] = [];

  Items.forEach((item) => {
    if (item['account_id']) {
      accounts.push({
          accountId: item['account_id'],
          accountName: item['account_name'],
          accountEmail: item['account_email']
        }
      );

    }
  })

  return accounts
}