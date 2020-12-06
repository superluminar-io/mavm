// Adapted from and proudly found elsewhere at https://github.com/iann0036/aws-account-controller
// special thanks to Ian McKay
var synthetics = require('Synthetics');
const LOG = require('SyntheticsLogger');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const util = require('util');

const CONNECT_SSM_PARAMETER = '/superwerker/tests/connect' // TODO: rename

const CAPTCHA_KEY = process.env['CAPTCHA_KEY'];

const randomSuffix = uuidv4().split('-')[0];
const ACCOUNT_EMAIL = `superwerker-aws-test+${randomSuffix}@superluminar.io`; // TODO: this has to be generated from a subdomain which is under control so we can close the account automatically

exports.handler = async () => {
    return await signup();
};


const signup = async function () {

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

    await synthetics.executeStep('pwResetEmailRequest', async function () {

        await page.goto('https://portal.aws.amazon.com/billing/signup#/start')
        await page.waitForSelector('#ccEmail', {timeout: 15000});
        await page.type('#ccEmail', ACCOUNT_EMAIL);
        await page.waitFor(1000);
        await page.type('#ccPassword', secretdata.password);
        await page.waitFor(1000);
        await page.type('#ccRePassword', secretdata.password);
        await page.waitFor(1000);
        await page.type('#ccUserName', util.format(secretdata.accountname, randomSuffix));
        await page.waitFor(1000);

        await page.click('#cc-form-box > div.cc-form-big-box > div > div.cc-form-submit-click-box > button > span > input');

        try {
            await page.waitForSelector('#full-name', {timeout: 5000});
        } catch (e) {
            let captchanotdone = true;
            let captchaattempts = 0;
            while (captchanotdone) {
                captchaattempts += 1;
                if (captchaattempts > 6) {
                    return;
                }

                let recaptchaimg = await page.$('#imageCaptcha');
                let recaptchaurl = await page.evaluate((obj) => {
                    return obj.getAttribute('src');
                }, recaptchaimg);


                let captcharesult = await solveCaptcha2captcha(page, recaptchaurl);
                let input2 = await page.$('#guess');
                await input2.press('Backspace');
                await input2.type(captcharesult, {delay: 100});

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
        var captchanotdone = true;
        var captchaattemptsfordiva = 0;
        while (captchanotdone) {
            captchaattemptsfordiva += 1;
            if (captchaattemptsfordiva > 5) {
                throw "Could not confirm phone number verification - possible error in DIVA system or credit card";
            }
            try {
                let submitc = await page.$('#btnCall');

                let recaptchaimgx = await page.$('#imageCaptcha');
                let recaptchaurlx = await page.evaluate((obj) => {
                    return obj.getAttribute('src');
                }, recaptchaimgx);

                let result = await solveCaptcha2captcha(page, recaptchaurlx);

                let input32 = await page.$('#guess');
                await input32.press('Backspace');
                await input32.type(result, { delay: 100 });

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
            await page.waitForSelector('#verification-complete-button', {timeout: 30000});
            await page.click('#verification-complete-button');
        } catch(err) {
            LOG.error("Could not confirm phone number verification - possible error in DIVA system or credit card");
            throw err;
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
