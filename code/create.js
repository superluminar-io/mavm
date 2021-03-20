// Adapted from and proudly found elsewhere at https://github.com/iann0036/aws-account-controller
// special thanks to Ian McKay
var synthetics = require('Synthetics');
const LOG = require('SyntheticsLogger');
const AWS = require('aws-sdk');
const sqs = new AWS.SQS();
const fs = require('fs');
const util = require('util');

const CONNECT_SSM_PARAMETER = '/superwerker/tests/connect' // TODO: rename
const PRINCIPAL = process.env['PRINCIPAL'];
const QUEUE_URL = process.env['QUEUE_URL'];
const INVOICE_EMAIL = process.env['INVOICE_EMAIL'];
const INVOICE_CURRENCY = process.env['INVOICE_CURRENCY'];

exports.handler = async () => {
    return await signup();
};

const signup = async function () {

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

    const ssm = new AWS.SSM({region: 'us-east-1'});

    let connectssmparameter = await ssm.getParameter({
        Name: CONNECT_SSM_PARAMETER
    }).promise();

    let variables = JSON.parse(connectssmparameter['Parameter']['Value']);


    let page = await synthetics.getPage();
    await signupPage1(page, ACCOUNT_EMAIL, secretdata, ACCOUNT_NAME);

    await signupPageTwo(page, secretdata, variables);

    await signupCreditCard(page, secretdata);

    await signupVerification(page, variables, ACCOUNT_NAME, ssm);

    await loginToAccount(page, ACCOUNT_EMAIL, secretdata);

    await createCrossAccountRole(page, PRINCIPAL);

    await billingInformation(page, INVOICE_CURRENCY, INVOICE_EMAIL);

    await saveAccountIdAndFinish(page, ACCOUNT_NAME, ACCOUNT_EMAIL, sqsMessage);
};

const httpGet = url => {
    const https = require('https');
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            res.setEncoding('utf8');
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
};

const httpGetBinary = url => {
    const https = require('https');
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            //res.setEncoding('binary');
            var data = [ ];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
        }).on('error', reject);
    });
};

async function solveAudioCaptcha(audioCaptchaUrl, ACCOUNT_NAME) {

    const s3 = new AWS.S3();
    const transcribe = new AWS.TranscribeService();

    let audioCaptchaUrlResult = await httpGetBinary(audioCaptchaUrl);
    let audioCaptchaUrlTempDir = fs.mkdtempSync('/tmp/audiocaptcha');
    let audioCaptchaUrlFilename = audioCaptchaUrlTempDir + '/audiocaptcha.mp3';
    fs.writeFileSync(audioCaptchaUrlFilename, audioCaptchaUrlResult);

    const { v4: uuidv4 } = require('uuid');
    const randomSuffix = uuidv4().split('-')[0];
    const transcriptionJobName = ACCOUNT_NAME + randomSuffix;
    const s3Key = transcriptionJobName + '.mp3'
    const s3Bucket = 'audiocaptchatest2';
    await s3.upload({
            'Bucket': s3Bucket,
            'Body': fs.readFileSync(audioCaptchaUrlFilename),
            'Key': s3Key,
        }
    ).promise(); // TODO: auto-expiration

    let audioCaptchaS3Uri = `s3://${s3Bucket}/${s3Key}`;
    await transcribe.startTranscriptionJob(
        {
            TranscriptionJobName: transcriptionJobName,
            Media: {
                MediaFileUri: audioCaptchaS3Uri
            },
            LanguageCode: "en-US",
        }
    ).promise();

    let transScribeJobfinished = false;
    let transScribeResultUrl = '';
    while (!transScribeJobfinished) {
        let transScribeJob = await transcribe.getTranscriptionJob(
            {
                TranscriptionJobName: transcriptionJobName,
            }
        ).promise();
        if (transScribeJob.TranscriptionJob.TranscriptionJobStatus === 'COMPLETED') {
            transScribeResultUrl = transScribeJob.TranscriptionJob.Transcript.TranscriptFileUri;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 5000)); // one does not simply sleep() in node
    }

    let data = await httpGet(transScribeResultUrl);
    let audioCaptchaTranscribeResult = JSON.parse(data);

    let solvedAudioCaptcha = '';

    audioCaptchaTranscribeResult.results.items.forEach(item => {

        function wordsToNumbers(content) {
            const numbers = ['zero', 'one', 'two', 'three', 'for', 'five', 'six', 'seven', 'eight', 'nine'];
            const key = numbers.indexOf(content.toLowerCase());
            if (key !== -1) {
                return key;
            }
            return '';
        }

        if (!isNaN(parseInt(item.alternatives[0].content))) {
            solvedAudioCaptcha += item.alternatives[0].content;
        } else {
            solvedAudioCaptcha += wordsToNumbers(item.alternatives[0].content);
        }
    });
    console.debug("Resolved audio captcha: " + solvedAudioCaptcha)
    return solvedAudioCaptcha;
}

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

    let solveCaptcha = false
    try {
        await page.waitForSelector('#captchaGuess', {timeout: 5000, visible: true});
        solveCaptcha = true;
    } catch (e) {
        // continue normal flow
    }

    if (solveCaptcha) {
        captchanotdone = true;
        captchaattempts = 0;
        while (captchanotdone) {
            captchaattempts += 1;
            if (captchaattempts > 6) {
                return;
            }

            await page.waitFor(3000); // wait for captcha_image to be loaded
            let recaptchaimg = await page.$('#captcha_image');
            let recaptchaurl = await page.evaluate((obj) => {
                return obj.getAttribute('src');
            }, recaptchaimg);

            let captcharesult = await solveCaptcha2captcha(page, recaptchaurl, secretdata.twocaptcha_apikey);

            let input2 = await page.$('#captchaGuess');

            await input2.press('Backspace');
            await input2.type(captcharesult, {delay: 100});

            await page.waitFor(3000);

            await page.click('#submit_captcha');

            await page.waitFor(5000);

            let errormessagediv = await page.$('#error_message');
            let errormessagedivstyle = await page.evaluate((obj) => {
                return obj.getAttribute('style');
            }, errormessagediv);

            if (errormessagedivstyle.includes("display: none")) {
                captchanotdone = false;
            }
            await page.waitFor(2000);
        }
    }


    let input4 = await page.$('#password');
    await input4.press('Backspace');
    await input4.type(secretdata.password, {delay: 100});

    await page.click('#signin_button');
    await page.waitFor(8000);
}

async function signupVerification(page, variables, ACCOUNT_NAME, ssm) {

    await page.waitFor(10000); // wait for redirects to finish

    await page.click('input[name="divaMethod"][value="Phone"]:first-child');
    await page.waitFor(1000);

    let portalphonenumber = await page.$('input[name="phoneNumber"]:first-child');
    await portalphonenumber.press('Backspace');
    await portalphonenumber.type(variables['PHONE_NUMBER'].replace("+1", ""), {delay: 100});
    var phonecode = "";
    var phonecodetext = "";

    var captchanotdone = true;
    var captchaattemptsfordiva = 0;
    while (captchanotdone) {
        captchaattemptsfordiva += 1;
        if (captchaattemptsfordiva > 10) {
            throw "Could not confirm phone number verification - possible error in DIVA system or credit card";
        }
        try {

            const captchaResponse = page.waitForResponse((response) => {
                return response.url().startsWith("https://opfcaptcha-prod.s3.amazonaws.com/")
            });

            await page.waitForSelector('img[alt="Change to audio security check"]:first-child');
            await page.click('img[alt="Change to audio security check"]:first-child');
            await page.waitFor(1000);

            await page.waitForSelector('span[aria-label="Play Audio"]')
            await page.click('span[aria-label="Play Audio"]')

            await page.waitFor(1000);

            const audioCaptchaUrl = (await captchaResponse).url();
            console.log('Audio captcha URL:', audioCaptchaUrl);

            let solvedAudioCaptcha = await solveAudioCaptcha(audioCaptchaUrl, ACCOUNT_NAME);

            let input32 = await page.$('input[name="captchaGuess"]:first-child');
            await input32.press('Backspace');
            await input32.type(solvedAudioCaptcha, {delay: 100});
            await page.waitFor(1000);

            let submitc = await page.$('#IdentityVerification > fieldset > awsui-button > button');
            await submitc.click();

            try {
                await page.waitForSelector('#phonePin', {timeout: 5000});
                phonecode = await page.$('#phonePin');
                phonecodetext = await page.evaluate(el => el.textContent, phonecode);

                if (phonecodetext.trim().length == 4) {
                    captchanotdone = false;
                } else {
                    await page.waitFor(5000);
                }
            } catch (error) {
                console.log('captcha probably not done, continue', error)
                LOG.info(error);
            }
        } catch (error) {
            LOG.error(error);
        }
    }

    variables['CODE'] = phonecodetext;

    await ssm.putParameter({
        Name: CONNECT_SSM_PARAMETER,
        Type: "String",
        Value: JSON.stringify(variables),
        Overwrite: true
    }).promise();

    // wait for amazon connect to answer the call
    await page.waitForSelector('#SupportPlan > fieldset > div.CenteredButton_centeredButtonContainer_3Xaah > awsui-button > button', {timeout: 120000});
    await page.click('#SupportPlan > fieldset > div.CenteredButton_centeredButtonContainer_3Xaah > awsui-button > button');

    // "Go to the AWS Management Console" selector
    await page.waitForSelector('#aws-signup-app > div > div.App_content_5H0by > div > div > div:nth-child(5) > awsui-button > a')
}

async function saveAccountIdAndFinish(page, ACCOUNT_NAME, ACCOUNT_EMAIL, sqsMessage) {
    await page.goto('https://console.aws.amazon.com/billing/rest/v1.0/account', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitFor(3000);
    const innerText = await page.evaluate(() => document.querySelector('pre').innerText);
    const account = JSON.parse(innerText);

    const ddb = new AWS.DynamoDB();
    await ddb.updateItem({
        Key: {
            account_name: {
                S: ACCOUNT_NAME
            }
        },
        TableName: 'account',
        UpdateExpression: "SET account_id = :account_id, account_email = :account_email, registration_date = :registration_date, account_status = :account_status",
        ExpressionAttributeValues: {
            ":account_id": {
                S: account['accountId']
            },
            ":account_email": {
                S: ACCOUNT_EMAIL
            },
            ":registration_date": {
                S: new Date().toISOString()
            },
            ":account_status": {
                S: 'CREATED'
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

async function signupPage1(page, ACCOUNT_EMAIL, secretdata, ACCOUNT_NAME) {
    await page.goto('https://portal.aws.amazon.com/billing/signup#/start')
    await page.waitForSelector('#awsui-input-0', {timeout: 15000});

    // remove cookie banner so that it's possible to click on the submit button later, otherwise the UI thinks the button cannot be clicked
    await page.$eval('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary', e => e.click());
    await page.waitFor(5000);

    await page.type('#awsui-input-0', ACCOUNT_EMAIL);
    await page.waitFor(1000);
    await page.type('#awsui-input-1', secretdata.password);
    await page.waitFor(1000);
    await page.type('#awsui-input-2', secretdata.password);
    await page.waitFor(1000);
    await page.type('#awsui-input-3', ACCOUNT_NAME);

    await page.waitFor(1000);

    await page.click('#CredentialCollection button:first-child');
}

async function signupPageTwo(page, secretdata, variables) {

    let solveCaptcha = false;
    try {
        await page.waitForSelector('#captchaGuess', {timeout: 5000, visible: true});
        console.log('trying to solve captcha');
        solveCaptcha = true;
    } catch (e) {
        // continue normal flow
    }

    if (solveCaptcha) {
        captchanotdone = true;
        captchaattempts = 0;
        while (captchanotdone) {
            captchaattempts += 1;
            if (captchaattempts > 6) {
                return;
            }

            await page.waitFor(3000); // wait for captcha_image to be loaded
            let recaptchaimg = await page.$('img[alt="captcha"]:first-child');
            let recaptchaurl = await page.evaluate((obj) => {
                return obj.getAttribute('src');
            }, recaptchaimg);

            let captcharesult = await solveCaptcha2captcha(page, recaptchaurl, secretdata.twocaptcha_apikey);

            let input2 = await page.$('input[name="captchaGuess"]:first-child');

            await input2.press('Backspace');
            await input2.type(captcharesult, {delay: 100});

            await page.waitFor(3000);

            await page.click('#CredentialCollection > fieldset > awsui-button > button');

            try {
                await page.waitForSelector('#awsui-radio-button-1', {timeout: 10000});
                captchanotdone = false
            } catch {
                console.log("captcha not solved, trying again")
            }
        }
    }

    await page.waitForSelector('#awsui-radio-button-1', {timeout: 5000});
    await page.click('#awsui-radio-button-1')
    await page.waitFor(1000);

    await page.type('input[name="address.fullName"]:first-child', secretdata.company);
    await page.waitFor(1000);

    await page.type('input[name="address.company"]:first-child', secretdata.company);
    await page.waitFor(1000);

    await page.type('input[name="address.phoneNumber"]:first-child', variables['PHONE_NUMBER'].replace('+1', '+1 '));
    await page.waitFor(1000);

    await page.click('#awsui-select-1 > div > awsui-icon > span'); // click country selection
    await page.waitFor(1000);

    const option = (await page.$x(
        '//*[@id = "awsui-select-1-dropdown-options"]//span[text() = "' + secretdata.country + '"]'
    ))[0];
    await option.click();
    await page.waitFor(1000);

    await page.type('input[name="address.addressLine1"]:first-child', secretdata.streetaddress);
    await page.waitFor(1000);

    await page.type('input[name="address.city"]:first-child', secretdata.city);
    await page.waitFor(1000);

    await page.type('input[name="address.state"]:first-child', secretdata.state);
    await page.waitFor(1000);

    await page.type('input[name="address.postalCode"]:first-child', secretdata.postalcode);
    await page.waitFor(1000);

    await page.click('input[name="agreement"]:first-child');
    await page.waitFor(1000);

    await page.click('#ContactInformation > fieldset > awsui-button > button')
    await page.waitFor(1000);
}

async function signupCreditCard(page, secretdata) {
    await page.waitForSelector('input[name="cardNumber"]:first-child');

    let input5 = await page.$('input[name="cardNumber"]:first-child');
    await input5.press('Backspace');
    await input5.type(secretdata.ccnumber, {delay: 100});
    await page.waitFor(1000);

    await page.click('#awsui-select-2 > div > awsui-icon > span'); // click month selection
    await page.waitFor(1000);

    const ccExpireDate = new Date(secretdata.ccyear, secretdata.ccmonth - 1, 1);
    const ccExpireMonthName = ccExpireDate.toLocaleString('default', { month: 'long' });

    await (await page.$x(
        '//*[@id = "awsui-select-2-dropdown-options"]//span[text() = "' + ccExpireMonthName + '"]'
    ))[0].click();
    await page.waitFor(1000);

    await page.click('#awsui-select-3 > div > awsui-icon > span'); // click month selection
    await page.waitFor(1000);

    await (await page.$x(
        '//*[@id = "awsui-select-3-dropdown-options"]//span[text() = "' + secretdata.ccyear + '"]'
    ))[0].click();
    await page.waitFor(1000);

    let input6 = await page.$('input[name="accountHolderName"]:first-child');
    await input6.press('Backspace');
    await input6.type(secretdata.ccname, {delay: 100});
    await page.waitFor(2000);

    await page.click('#PaymentInformation > fieldset > awsui-button > button')
    await page.waitFor(1000);
}

async function createCrossAccountRole(page, PRINCIPAL) {
    const crossAccountRole = 'OVMCrossAccountRole';

    let init = util.format('https://console.aws.amazon.com/iam/home?region=eu-west-1#/roles$new?step=review&roleType=crossAccount&accountID=%s&policies=arn:aws:iam::aws:policy%2FAdministratorAccess', PRINCIPAL)

    // log in to get account id
    await page.goto(init, {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });

    let selector = '#iam-content > roleslist > parent-view > div.ng-scope > new-role-wizard > wizard > div > div.wizard-body > div > div.wizard-footer.wizard-footer-height > div.buttons > awsui-button.wizard-next-button > button'

    await page.waitForSelector(selector, {timeout: 5000});
    await page.click(selector);
    await page.waitFor(5000);

    await page.waitForSelector(selector, {timeout: 5000});
    await page.click(selector);
    await page.waitFor(5000);

    await page.waitForSelector(selector, {timeout: 5000});
    await page.click(selector);
    await page.waitFor(5000);

    await page.type('#awsui-textfield-13', crossAccountRole, {delay: 100});
    await page.waitFor(5000);

    // click on "create role"
    await page.waitForSelector(selector, {timeout: 5000});
    await page.click(selector);
    await page.waitFor(5000);
}

async function billingInformation(page, INVOICE_CURRENCY, INVOICE_EMAIL) {
    await page.goto('https://console.aws.amazon.com/billing/home?#/account');
    await page.waitFor(3000);
    await page.waitForSelector('#account__edit-currency-preference');
    await page.click('#account__edit-currency-preference');

    await page.waitForSelector('#account__select-currencies-list');
    await page.waitFor(3000);
    await page.select('#account__select-currencies-list', INVOICE_CURRENCY);

    await page.waitFor(3000);
    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(3) > div > div > div > div.account-information-update-buttons.margin-top-10 > button.btn.btn-primary');
    await page.waitFor(3000);

    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > a')
    await page.waitFor(3000);
    await page.type('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > div > div > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(1) > input', 'Bill Gates')
    await page.waitFor(1000);
    await page.type('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > div > div > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(2) > input', 'CFO')
    await page.waitFor(1000);
    await page.type('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > div > div > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(3) > input', INVOICE_EMAIL)
    await page.waitFor(1000);
    await page.type('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > div > div > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(4) > input', '+1234567890')
    await page.waitFor(1000);
    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > div > div > div > div.account-information-update-buttons.margin-top-10.ng-scope > button.btn.btn-primary');
    await page.waitFor(3000);

    await page.goto('https://console.aws.amazon.com/billing/home?#/preferences');
    await page.waitFor(3000);
    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.plutonium.aws-billing-console-root.awsui-v1-root > div > div > div.aws-billing-console-span10 > div:nth-child(2) > div > label > span > i');
    await page.waitFor(3000);
    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.aws-billing-console-span10 > div.plutonium.aws-billing-console-root.awsui-v1-root > div > div > button');
    await page.waitFor(3000);
}

const solveCaptcha2captcha = async (page, url, twocaptcha_apikey) => {
    var imgbody = await httpGetBinary(url).then(res => {
        return res;
    });

    var captcharef = await httpPostJson('https://2captcha.com/in.php', {
        'key': twocaptcha_apikey,
        'method': 'base64',
        'body': imgbody.toString('base64')
    }).then(res => {
        console.log('2Captcha: ' + res)
        return res.split("|").pop();
    });

    var captcharesult = '';
    var i = 0;
    while (!captcharesult.startsWith("OK") && i < 20) {
        await new Promise(resolve => { setTimeout(resolve, 5000); });

        captcharesult = await httpGet('https://2captcha.com/res.php?key=' + twocaptcha_apikey + '&action=get&id=' + captcharef).then(res => {
            return res;
        });

        i++;
    }

    return captcharesult.split("|").pop();
}

const httpPostJson = (url, postData) => {
    const https = require('https');
    var querystring = require('querystring');

    postData = querystring.stringify(postData);

    var options = {
        method: 'POST',
    };

    return new Promise((resolve, reject) => {
        let req = https.request(url, options);
        req.on('response', (res) => {
            //If the response status code is not a 2xx success code
            if (res.statusCode < 200 || res.statusCode > 299) {
                reject("Failed: " + options.path);
            }

            res.setEncoding('utf8');
            let body = '';
            res.on('data', chunk => {
                body += chunk;
            });
            res.on('end', () => resolve(body));
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.write(postData);
        req.end();
    });
};
