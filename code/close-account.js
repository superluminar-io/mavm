// Adapted from and proudly found elsewhere at https://github.com/iann0036/aws-account-controller
// special thanks to Ian McKay
var synthetics = require('Synthetics');
const LOG = require('SyntheticsLogger');
const AWS = require('aws-sdk');
const sqs = new AWS.SQS();

const QUEUE_URL = process.env['QUEUE_URL'];

exports.handler = async () => {
    return await closeAccountHandler();
};

async function closeAccount(page) {
    await page.goto('https://console.aws.amazon.com/billing/home?#/account', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });

    await page.waitFor(8000);

    let closeaccountcbs = await page.$$('.close-account-checkbox > input');
    await closeaccountcbs.forEach(async (cb) => {
        await cb.click();
    });

    await page.waitFor(1000);

    await page.click('.btn-danger'); // close account button

    await page.waitFor(1000);

    await page.click('.modal-footer > button.btn-danger'); // confirm close account button

    await page.waitFor(5000);

    // "Account has been closed" box
    await page.waitForSelector('#billing-console-root > div > div > div.root--3xRQC.awsui > div > div > div > div.text--37m-5', 10000);
}

const closeAccountHandler = async function () {

    let ACCOUNT_NAME;
    let ACCOUNT_EMAIL;
    let sqsMessage;

    if (process.env['ACCOUNT_NAME']) {
        ACCOUNT_NAME = process.env['ACCOUNT_NAME'];
        ACCOUNT_EMAIL = process.env['ACCOUNT_EMAIL'];
    } else {
        sqsMessage = await sqs.receiveMessage({
            QueueUrl: QUEUE_URL,
            MaxNumberOfMessages: 1,
            VisibilityTimeout: 300,
        }).promise();
        if (typeof sqsMessage.Messages === 'undefined') {
            return;
        }

        const accountCreationRequest = JSON.parse(sqsMessage.Messages[0].Body);
        ACCOUNT_NAME = accountCreationRequest.account_name;
        ACCOUNT_EMAIL = accountCreationRequest.account_email;
    }

    const secretsmanager = new AWS.SecretsManager();
    let secretsmanagerresponse = await secretsmanager.getSecretValue({
        SecretId: '/aws-organizations-vending-machine/ccdata'
    }).promise();
    let secretdata = JSON.parse(secretsmanagerresponse.SecretString);

    let page = await synthetics.getPage();

    await synthetics.executeStep('loginToAccount', async function () {
        await loginToAccount(page, ACCOUNT_EMAIL, secretdata);
    });

    await synthetics.executeStep('closeAccount', async function () {
        await closeAccount(page);
    });

    await synthetics.executeStep('markAccountDeleted', async function () {
        await markAccountDeleted(page, ACCOUNT_NAME, sqsMessage);
    });
};

async function loginToAccount(page, ACCOUNT_EMAIL, secretdata) {
    // log in to get account id
    await page.goto('https://console.aws.amazon.com/console/home', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitForSelector('#resolving_input', {timeout: 15000});
    await page.waitFor(500);

    let resolvinginput = await page.$('#resolving_input');
    await resolvinginput.press('Backspace');
    await resolvinginput.type(ACCOUNT_EMAIL, {delay: 100});

    await page.click('#next_button');
    await page.waitFor(3000);

    let input4 = await page.$('#password');
    await input4.press('Backspace');
    await input4.type(secretdata.password, {delay: 100});

    await page.click('#signin_button');
    await page.waitFor(8000);
}


async function markAccountDeleted(page, ACCOUNT_NAME, sqsMessage) {
    const ddb = new AWS.DynamoDB();
    await ddb.updateItem({
        Key: {
            account_name: {
                S: ACCOUNT_NAME
            }
        },
        TableName: 'account',
        UpdateExpression: "SET deletion_date = :deletion_date, account_status = :account_status",
        ExpressionAttributeValues: {
            ":deletion_date": {
                S: new Date().toISOString()
            },
            ":account_status": {
                S: 'CLOSED'
            },

        },
    }).promise();

    if (sqsMessage) {
        await sqs.deleteMessage({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: sqsMessage.Messages[0].ReceiptHandle,
        }).promise();
    }
}