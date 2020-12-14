// Adapted from and proudly found elsewhere at https://github.com/iann0036/aws-account-controller
// special thanks to Ian McKay
var synthetics = require('Synthetics');
const LOG = require('SyntheticsLogger');
const AWS = require('aws-sdk');
const fs = require('fs');

const CONNECT_SSM_PARAMETER = '/superwerker/tests/connect' // TODO: rename

exports.handler = async () => {
    return await signup();
};

const signup = async function () {

    const sqs = new AWS.SQS();
    const QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/824014778649/accountCreationQueue';
    const sqsMessage = await sqs.receiveMessage({
        QueueUrl: QUEUE_URL, // fixme: don't hardcode
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 300,
    }).promise();
    if (typeof sqsMessage.Messages === 'undefined') {
        return;
    }

    const accountCreationRequest = JSON.parse(sqsMessage.Messages[0].Body);
    const ACCOUNT_NAME = accountCreationRequest.accountName;
    const ACCOUNT_EMAIL = accountCreationRequest.accountEmail;

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

    await synthetics.executeStep('signup', async function () {

        await page.goto('https://portal.aws.amazon.com/billing/signup#/start')
        await page.waitForSelector('#ccEmail', {timeout: 15000});
        await page.type('#ccEmail', ACCOUNT_EMAIL);
        await page.waitFor(1000);
        await page.type('#ccPassword', secretdata.password);
        await page.waitFor(1000);
        await page.type('#ccRePassword', secretdata.password);
        await page.waitFor(1000);
        await page.type('#ccUserName', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.click('#cc-form-box > div.cc-form-big-box > div > div.cc-form-submit-click-box > button > span > input');

        try {
            await page.waitForSelector('#full-name', {timeout: 5000});
        } catch (e) {

            await page.click('#switchToAudioBtn');

            await page.waitForSelector('#audioPlayBtn')
            await page.click('#audioPlayBtn')

            let captchanotdone = true;
            let captchaattempts = 0;
            while (captchanotdone) {
                captchaattempts += 1;
                if (captchaattempts > 6) {
                    return;
                }

                await page.waitForSelector('#refreshAudioBtn')
                await page.click('#refreshAudioBtn')

                await page.waitFor(2000);
                await page.waitForSelector('#audioCaptcha')
                let audioCaptcha = await page.$('#audioCaptcha');
                let audioCaptchaUrl = await page.evaluate((audioCaptcha) => {
                    return audioCaptcha.getAttribute('src');
                }, audioCaptcha);

                let solvedAudioCaptcha = await solveAudioCaptcha(audioCaptchaUrl, ACCOUNT_NAME, captchaattemptsfordiva);
                let input2 = await page.$('#guess');
                await input2.press('Backspace');
                await input2.type(solvedAudioCaptcha, {delay: 100});

                await page.waitFor(3000);

                await page.click('#a-autoid-1 > span > input');

                try {
                    await page.waitForSelector('#full-name', {timeout: 5000});
                    captchanotdone = false;
                } catch (e) {
                    captchanotdone = true;
                }
            }
        }


        await page.type('#company', secretdata.company, {delay: 100});
        await page.waitFor(1000);

        await page.type('#phone-number', variables['PHONE_NUMBER'], {delay: 100});
        await page.waitFor(1000);

        await page.type('#postal-code', secretdata.postalcode, {delay: 100});
        await page.waitFor(1000);

        const option = (await page.$x(
            '//*[@id = "country"]/option[text() = "' + secretdata.country + '"]'
        ))[0];
        const value = await (await option.getProperty('value')).jsonValue();
        await page.select('#country', value);

        await page.type('#street-address-1', secretdata.streetaddress, {delay: 100});
        await page.waitFor(1000);

        await page.type('#city', secretdata.city, {delay: 100});
        await page.waitFor(1000);

        await page.type('#state', secretdata.state, {delay: 100});
        await page.waitFor(1000);

        await page.click('div.agreement-checkbox > input')
        await page.waitFor(1000);

        await page.click('div.form-submit-click-box > button > span > input')
        await page.waitFor(1000);

        let input5 = await page.$('#credit-card-number');
        await input5.press('Backspace');
        await input5.type(secretdata.ccnumber, { delay: 100 });

        await page.select('#expirationMonth', (parseInt(secretdata.ccmonth)-1).toString());

        await page.waitFor(2000);

        let currentyear = new Date().getFullYear();

        await page.select('select[name=\'expirationYear\']', (parseInt(secretdata.ccyear)-currentyear).toString());

        let input6 = await page.$('#accountHolderName');
        await input6.press('Backspace');
        await input6.type(secretdata.ccname, { delay: 100 });

        await page.waitFor(2000);

        await page.click('.form-submit-click-box > button');

        await page.waitForSelector('#ng-app > div > div.main-content-new.ng-scope > div.ng-scope > div > div.form-box > div.form-content-box > div.form-big-box.ng-pristine.ng-invalid.ng-invalid-required.ng-valid-pattern.ng-valid-phone-length-limit.ng-valid-maxlength > div.contact-form-box > div:nth-child(1) > div > label:nth-child(2) > input', {timeout: 5000});
        await page.$eval('#ng-app > div > div.main-content-new.ng-scope > div.ng-scope > div > div.form-box > div.form-content-box > div.form-big-box.ng-pristine.ng-invalid.ng-invalid-required.ng-valid-pattern.ng-valid-phone-length-limit.ng-valid-maxlength > div.contact-form-box > div:nth-child(1) > div > label:nth-child(2) > input', elem => elem.click());

        let usoption = await page.$('option[label="United States (+1)"]');
        let usvalue = await page.evaluate( (obj) => {
            return obj.getAttribute('value');
        }, usoption);

        await page.select('#countryCode', usvalue);


        let portalphonenumber = await page.$('#phoneNumber');
        await portalphonenumber.press('Backspace');
        await portalphonenumber.type(variables['PHONE_NUMBER'].replace("+1", ""), { delay: 100 });
        var phonecode = "";
        var phonecodetext = "";

        await page.click('#switchToAudioBtn');

        await page.waitForSelector('#audioPlayBtn')
        await page.click('#audioPlayBtn')

        var captchanotdone = true;
        var captchaattemptsfordiva = 0;
        while (captchanotdone) {
            captchaattemptsfordiva += 1;
            if (captchaattemptsfordiva > 5) {
                throw "Could not confirm phone number verification - possible error in DIVA system or credit card";
            }
            try {
                await page.waitForSelector('#refreshAudioBtn')
                await page.click('#refreshAudioBtn')

                await page.waitFor(2000);
                await page.waitForSelector('#audioCaptcha')
                let audioCaptcha = await page.$('#audioCaptcha');
                let audioCaptchaUrl = await page.evaluate((audioCaptcha) => {
                    return audioCaptcha.getAttribute('src');
                }, audioCaptcha);

                let solvedAudioCaptcha = await solveAudioCaptcha(audioCaptchaUrl, ACCOUNT_NAME, captchaattemptsfordiva);

                let input32 = await page.$('#guess');
                await input32.press('Backspace');
                await input32.type(solvedAudioCaptcha, { delay: 100 });

                let submitc = await page.$('#btnCall');
                await submitc.click();
                await page.waitFor(5000);

                await page.waitForSelector('.phone-pin-number', {timeout: 5000});

                phonecode = await page.$('.phone-pin-number > span');
                phonecodetext = await page.evaluate(el => el.textContent, phonecode);

                if (phonecodetext.trim().length == 4) {
                    captchanotdone = false;
                } else {
                    await page.waitFor(5000);
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

        try {
            // wait for amazon connect to answer the call
            await page.waitFor(30000);
            await page.click('#verification-complete-button');

            // TODO: read account id and write to dyanomo

            await sqs.deleteMessage({
                QueueUrl: QUEUE_URL,
                ReceiptHandle: sqsMessage.Messages[0].ReceiptHandle,
            }).promise();
        } catch(err) {
            LOG.error("Could not confirm phone number verification - possible error in DIVA system or credit card:" + err);
            throw err;
        }
    });
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

async function solveAudioCaptcha(audioCaptchaUrl, ACCOUNT_NAME, captchaattempts) {

    const s3 = new AWS.S3();
    const transcribe = new AWS.TranscribeService();

    let audioCaptchaUrlResult = await httpGetBinary(audioCaptchaUrl);
    let audioCaptchaUrlTempDir = fs.mkdtempSync('/tmp/audiocaptcha');
    let audioCaptchaUrlFilename = audioCaptchaUrlTempDir + '/audiocaptcha.mp3';
    fs.writeFileSync(audioCaptchaUrlFilename, audioCaptchaUrlResult);

    const s3Key = ACCOUNT_NAME + '.mp3'
    const s3Bucket = 'audiocaptchatest2';
    await s3.upload({
            'Bucket': s3Bucket,
            'Body': fs.readFileSync(audioCaptchaUrlFilename),
            'Key': s3Key,
        }
    ).promise(); // TODO: auto-expiration

    let audioCaptchaS3Uri = `s3://${s3Bucket}/${s3Key}`;
    const transcriptionJobName = ACCOUNT_NAME + captchaattempts;
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
        let content = parseInt(item.alternatives[0].content);

        function wordsToNumbers(content) {
            const numbers = ['zero', 'one', 'two', 'three', 'for', 'five', 'six', 'seven', 'eight', 'nine'];
            const key = numbers.indexOf(content);
            if (key !== -1) {
                return key;
            }
            return '';
        }

        if (!isNaN(content)) {
            solvedAudioCaptcha += content;
        } else {
            solvedAudioCaptcha += wordsToNumbers(item.alternatives[0].content);
        }
    });
    console.debug("Resolved audio captcha: " + solvedAudioCaptcha)
    return solvedAudioCaptcha;
}