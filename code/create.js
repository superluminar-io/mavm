// Adapted from and proudly found elsewhere at https://github.com/iann0036/aws-account-controller
// special thanks to Ian McKay
var synthetics = require('Synthetics');
const LOG = require('SyntheticsLogger');
const AWS = require('aws-sdk');
const ssm = new AWS.SSM();

const organizations = new AWS.Organizations({region: 'us-east-1'});

const CONNECT_SSM_PARAMETER = '/superwerker/tests/connect'

const CAPTCHA_KEY = 'xxxx';

const ACCOUNT_EMAIL = process.env['ACCOUNT_EMAIL'];
const ACCOUNT_NAME = 'superwerker-test6-management';

exports.handler = async () => {
    return await signup();
};


const signup = async function () {

    const secretsmanager = new AWS.SecretsManager();
    let secretsmanagerresponse = await secretsmanager.getSecretValue({
        SecretId: '/superwerker/tests/accountdeletion'
    }).promise();

    let secretdata = JSON.parse(secretsmanagerresponse.SecretString);


    let page = await synthetics.getPage();

    await synthetics.executeStep('pwResetEmailRequest', async function () {

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

        await page.waitForSelector('#full-name', {timeout: 15000});
        await page.type('#company', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.type('#phone-number', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.type('#postal-code', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.type('#full-name', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.type('#full-name', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.type('#full-name', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.type('#full-name', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.type('#full-name', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.type('#full-name', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.type('#full-name', ACCOUNT_NAME);
        await page.waitFor(1000);

        await page.waitFor(100000);

        captchanotdone = true;
        captchaattempts = 0;
        while (captchanotdone) {
            captchaattempts += 1;
            if (captchaattempts > 6) {
                return;
            }

            let recaptchaimg = await page.$('#password_recovery_captcha_image');
            let recaptchaurl = await page.evaluate((obj) => {
                return obj.getAttribute('src');
            }, recaptchaimg);


            let captcharesult = await solveCaptcha2captcha(page, recaptchaurl);

            let input2 = await page.$('#password_recovery_captcha_guess');
            await input2.press('Backspace');
            await input2.type(captcharesult, {delay: 100});

            await page.waitFor(3000);


            await page.click('#password_recovery_ok_button');

            await page.waitFor(5000);

            let errormessagediv = await page.$('#password_recovery_error_message');
            let errormessagedivstyle = await page.evaluate((obj) => {
                return obj.getAttribute('style');
            }, errormessagediv);

            if (errormessagedivstyle.includes("display: none")) {
                captchanotdone = false;
            }
            await page.waitFor(2000);
        }
    });



};

const solveCaptcha2captcha = async (page, url) => {
    var imgbody = await httpGetBinary(url).then(res => {
        return res;
    });

    var captcharef = await httpPostJson('https://2captcha.com/in.php', {
        'key': CAPTCHA_KEY,
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

        captcharesult = await httpGet('https://2captcha.com/res.php?key=' + CAPTCHA_KEY + '&action=get&id=' + captcharef).then(res => {
            return res;
        });

        i++;
    }

    return captcharesult.split("|").pop();
}

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
