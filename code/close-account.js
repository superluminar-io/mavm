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

    account_closed = false;
    const confirm_close_account = '.modal-footer > button.btn-danger';
    try {
        await page.waitForSelector(confirm_close_account, {timeout: 1000});
    } catch (e) {
        console.log('account apparently already closed');
        account_closed = true;
    }

    if (!account_closed) {
        await page.click(confirm_close_account); // confirm close account button
        // "Account has been closed" box
        await page.waitForSelector('#billing-console-root > div > div > div.root--3xRQC.awsui > div > div > div > div.text--37m-5' , {timeout: 5000});
    }

    // wait for AWS to close the account
    await page.waitFor(180000);

    // check on EC2 page whether account has really been closed
    await page.goto('https://eu-west-1.console.aws.amazon.com/ec2/v2/home?region=eu-west-1#Home:', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(5000);
    await page.waitForFunction(
        'document.querySelector("body").innerText.includes("Authentication failed because your account has been suspended.")', {timeout: 1000}
    );
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

    await synthetics.executeStep('enableTaxInheritance', async function () {
        await enableTaxInheritance(page, secretdata, ACCOUNT_NAME);
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

    // remove cookie banner if present
    try {
        page.waitForSelector('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary');
        await page.click('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary');
        await page.waitFor(5000);
    } catch (e) {
    }
}

async function enableTaxInheritance(page, secretdata, ACCOUNT_NAME) {
    await page.goto('https://console.aws.amazon.com/billing/home?#/tax', {
        timeout: 0,
        waitUntil: ['domcontentloaded', 'networkidle0']
    });

    // edit the management account
    const managementAccountCheckbox = await page.$x('//div[@class="tax-table-cell ng-binding" and text()="' + ACCOUNT_NAME + '"]/preceding-sibling::div//input[@type="checkbox"]')
    await managementAccountCheckbox[0].click();
    await page.waitFor(1000);

    // click edit
    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > div:nth-child(2) > div:nth-child(1) > awsui-button-dropdown > div > button')
    await page.waitFor(1000);
    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > div:nth-child(2) > div:nth-child(1) > awsui-button-dropdown > div > div > ul > li:nth-child(1) > a')
    await page.waitFor(1000);

    // country "select" box
    const country_selector = '#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > awsui-modal:nth-child(6) > div.awsui-modal-__state-showing.awsui-modal-container > div > div > div.awsui-modal-body > div > span > form > awsui-control-group:nth-child(2) > div > div > div.awsui-control-group-control > span > awsui-select > span > span';
    await page.click(country_selector)
    await page.waitFor(1000);
    await page.type(country_selector, secretdata.country)
    await page.waitFor(1000);
    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > awsui-modal:nth-child(6) > div.awsui-modal-__state-showing.awsui-modal-container > div > div > div.awsui-modal-body > div > span > form > awsui-control-group:nth-child(2) > div > div > div.awsui-control-group-control > span > awsui-select > span > div > div > ul > li.awsui-select-option.awsui-select-option-highlight')
    await page.waitFor(1000);

    // tax id
    await page.type('#awsui-textfield-1', secretdata.vatid)
    await page.waitFor(1000);

    // legal entity
    await page.type('#awsui-textfield-2', secretdata.company)
    await page.waitFor(1000);

    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > awsui-modal:nth-child(6) > div.awsui-modal-__state-showing.awsui-modal-container > div > div > div.awsui-modal-footer > div > span > awsui-button:nth-child(1) > button')
    await page.waitFor(5000);

    try {
        await page.waitForSelector('#heritageCheckbox input', {timeout: 5000});

        const taxInheritanceEnabled = await page.$eval('#heritageCheckbox input', check => { return check.checked});
        if (taxInheritanceEnabled) {
            console.log('tax inheritance already enabled');
            return;
        }

        await page.click('#heritageCheckbox > label > div')
        await page.waitFor(1000);

        await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > awsui-modal:nth-child(7) > div.awsui-modal-__state-showing.awsui-modal-container > div > div > div.awsui-modal-footer > div > span > awsui-button:nth-child(1) > button')
        await page.waitFor(5000);
    } catch (e) {
        console.log('no tax inheritance, apparently because there are no sub-accounts');
    }
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