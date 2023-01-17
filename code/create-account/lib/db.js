const AWS = require("aws-sdk");

const saveAccountAndSetToInProgress = async (
    ACCOUNT_NAME,
    ACCOUNT_EMAIL,
    password
) => {
    const ddb = new AWS.DynamoDB();
    await ddb
        .updateItem({
            Key: {
                account_name: {
                    S: ACCOUNT_NAME,
                },
            },
            TableName: "account",
            UpdateExpression:
                "SET account_email = :account_email, registration_date = :registration_date, account_status = :account_status, password = :password",
            ExpressionAttributeValues: {
                ":account_email": {
                    S: ACCOUNT_EMAIL,
                },
                ":registration_date": {
                    S: new Date().toISOString(),
                },
                ":account_status": {
                    S: "IN_PROGRESS",
                },
                ":password": {
                    S: password,
                },
            },
        })
        .promise();
}


const saveAccountAndSetToCreated = async (
    ACCOUNT_NAME,
    accountId
) => {
    const ddb = new AWS.DynamoDB();
    await ddb
        .updateItem({
            Key: {
                account_name: {
                    S: ACCOUNT_NAME,
                },
            },
            TableName: "account",
            UpdateExpression:
                "SET account_id = :account_id, account_status = :account_status",
            ExpressionAttributeValues: {
                ":account_id": {
                    S: accountId,
                },
                ":account_status": {
                    S: "CREATED",
                }
            },
        })
        .promise();
}

module.exports = { saveAccountAndSetToInProgress, saveAccountAndSetToCreated }