// Adapted from and proudly found elsewhere at https://github.com/iann0036/aws-account-controller
// special thanks to Ian McKay
const AWS = require('aws-sdk');
const puppeteer = require('puppeteer');

const closeAccountHandler = async function () {
    const ACCOUNT_NAME = process.env['ACCOUNT_NAME'];
    const ACCOUNT_EMAIL = process.env['ACCOUNT_EMAIL'];

    const secretsmanager = new AWS.SecretsManager();
    let secretsmanagerresponse = await secretsmanager.getSecretValue({
        SecretId: '/aws-organizations-vending-machine/ccdata'
    }).promise();
    let secretdata = JSON.parse(secretsmanagerresponse.SecretString);

    const browser = await puppeteer.launch({args: ['--no-sandbox']});
    const page = await browser.newPage();

    await loginToAccount(page, ACCOUNT_EMAIL, secretdata);

    await enableTaxInheritance(page, secretdata, ACCOUNT_NAME);

    await closeAccount(page);

    await markAccountDeleted(page, ACCOUNT_NAME);

    await browser.close();
};

async function closeAccount(page) {
    await page.goto('https://console.aws.amazon.com/billing/home?#/account', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });

    await page.waitForSelector('input[data-testid="aws-billing-account-form-input-is-closing-account"]:first-child');

    await page.click('input[data-testid="aws-billing-account-form-input-is-closing-account"]:first-child');
    await page.click('input[data-testid="aws-billing-account-form-input-is-second-closing-account"]:first-child');
    await page.click('input[data-testid="aws-billing-account-form-input-is-third-closing-account"]:first-child');
    await page.click('input[data-testid="aws-billing-account-form-input-is-fourth-closing-account"]:first-child');

    await page.waitForTimeout(5000);

    await page.click('button[data-testid="aws-billing-account-form-button-close-account"]:first-child'); // close account button

    let account_closed = false;
    const confirm_close_account = '.modal-footer > button.btn-danger';
    try {
        await page.waitForSelector(confirm_close_account, {timeout: 1000});
    } catch (e) {
        console.log('account apparently already closed');
        account_closed = true;
    }

    if (!account_closed) {
        await page.waitForTimeout(5000);
        await page.click(confirm_close_account); // confirm close account button
        // "Account has been closed" box
    }

    // wait for AWS to close the account
    await page.waitForTimeout(180000);

    // check on EC2 page whether account has really been closed
    await page.goto('https://eu-west-1.console.aws.amazon.com/ec2/v2/home?region=eu-west-1#Home:', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitForTimeout(5000);
    await page.waitForFunction(
        'document.querySelector("body").innerText.includes("Authentication failed because your account has been suspended.")', {timeout: 1000}
    );
}

async function loginToAccount(page, ACCOUNT_EMAIL, secretdata) {
    // log in to get account id
    await page.goto('https://console.aws.amazon.com/console/home', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });
    await page.waitForSelector('#resolving_input', {timeout: 15000});
    await page.waitForTimeout(500);

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

            await page.waitForTimeout(3000); // wait for captcha_image to be loaded
            let recaptchaimg = await page.$('#captcha_image');
            let recaptchaurl = await page.evaluate((obj) => {
                return obj.getAttribute('src');
            }, recaptchaimg);

            let captcharesult = await solveCaptcha2captcha(page, recaptchaurl, secretdata.twocaptcha_apikey);

            let input2 = await page.$('#captchaGuess');

            await input2.press('Backspace');
            await input2.type(captcharesult, {delay: 100});

            await page.waitForTimeout(3000);

            await page.click('#submit_captcha');

            await page.waitForTimeout(5000);

            let errormessagediv = await page.$('#error_message');
            let errormessagedivstyle = await page.evaluate((obj) => {
                return obj.getAttribute('style');
            }, errormessagediv);

            if (errormessagedivstyle.includes("display: none")) {
                captchanotdone = false;
            }
            await page.waitForTimeout(2000);
        }
    }


    let input4 = await page.$('#password');
    await input4.press('Backspace');
    await input4.type(secretdata.password, {delay: 100});

    await page.click('#signin_button');
    await page.waitForTimeout(8000);

    // remove cookie banner if present
    try {
        await page.waitForSelector('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary');
        await page.click('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary');
        await page.waitForTimeout(5000);
    } catch (e) {
    }

    // remove wizard if present
    try {
        await page.waitForTimeout(5000);
        await page.waitForSelector('button[data-testid="awsc-nav-services-tooltip-confirm-button"]');
        await page.click('button[data-testid="awsc-nav-services-tooltip-confirm-button"]');
    } catch (e) {
    }
}

async function enableTaxInheritance(page, secretdata, ACCOUNT_NAME) {
    await page.goto('https://console.aws.amazon.com/billing/home?#/tax', {
        timeout: 0,
        waitUntil: ['domcontentloaded', 'networkidle0']
    });


    // remove cookie banner if present
    try {
        await page.waitForSelector('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary');
        await page.click('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary');
    } catch (e) {
    }

    // edit the management account
    const managementAccountCheckbox = await page.$x('//td//span[text()="' + ACCOUNT_NAME + '"]/parent::span/parent::td//parent::tr//input');
    await managementAccountCheckbox[0].click();
    await page.waitForTimeout(1000);

    await page.waitForSelector('awsui-button-dropdown[data-testid="manage-tax-reg-button"] button:first-child');
    await page.click('awsui-button-dropdown[data-testid="manage-tax-reg-button"] button:first-child');
    await page.waitForTimeout(1000);

    await page.waitForSelector('li[data-testid="edit_button"]');
    await page.click('li[data-testid="edit_button"]');

    // country "select" box
    await page.waitForSelector('#root_country');
    await page.click('#root_country');

    await page.waitForSelector('div[title="' + secretdata.country +'"]');
    await page.click('div[title="' + secretdata.country +'"]');

    // tax id
    await page.waitForSelector('#root_registrationNumber input:first-child')
    const taxId = await page.$('#root_registrationNumber input:first-child');
    await taxId.click({ clickCount: 3 }); // select existing content
    await taxId.type(secretdata.vatid);

    // legal entity
    await page.waitForSelector('#root_businessLegalName input:first-child');
    const company = await page.$('#root_businessLegalName input:first-child');
    await company.click({ clickCount: 3 }); // select existing content
    await company.type(secretdata.company);

    // street
    await page.waitForSelector('#root_addressLine1 input:first-child');
    const streetAddress = await page.$('#root_addressLine1 input:first-child');
    await streetAddress.click({ clickCount: 3 }); // select existing content
    await streetAddress.type(secretdata.streetaddress);

    // city
    await page.waitForSelector('#root_city input:first-child');
    const city = await page.$('#root_city input:first-child');
    await city.click({ clickCount: 3 }); // select existing content
    await city.type(secretdata.city);

    // zip
    await page.waitForSelector('#root_postalCode input:first-child');
    const postalCode = await page.$('#root_postalCode input:first-child');
    await postalCode.click({ clickCount: 3 }); // select existing content
    await postalCode.type(secretdata.postalcode);

    // confirm
    await page.waitForSelector('.awsui-wizard__primary-button button:first-child');
    await page.click('.awsui-wizard__primary-button button:first-child');

    // confirm
    await page.waitForTimeout(1000);
    await page.waitForSelector('.awsui-wizard__primary-button button:first-child');
    await page.click('.awsui-wizard__primary-button button:first-child');

    // confirm again
    await page.waitForSelector('awsui-button[data-testid="modal-submit-button"] button:first-child');
    await page.click('awsui-button[data-testid="modal-submit-button"] button:first-child');

    try {
        const taxInheritanceSelector = 'awsui-toggle[data-testid="tax-inheritance-toggle"] input:first-child';
        await page.waitForSelector(taxInheritanceSelector, {timeout: 5000});

        const taxInheritanceEnabled = await page.$eval(taxInheritanceSelector, check => { return check.checked});
        if (taxInheritanceEnabled) {
            console.log('tax inheritance already enabled');
            return;
        }

        await page.waitForTimeout(5000); // wait for checkbox to be clickable
        await page.click(taxInheritanceSelector);

        // confirm
        await page.waitForSelector('awsui-button[data-testid="modal-submit-button"] button:first-child');
        await page.click('awsui-button[data-testid="modal-submit-button"] button:first-child');

        await page.waitForTimeout(5000);
    } catch (e) {
        console.log('no tax inheritance, apparently because there are no sub-accounts', e);
    }
}


async function markAccountDeleted(page, ACCOUNT_NAME) {
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

(async () => {
    try {
        await closeAccountHandler();
    } catch (e) {
        console.log('got exception in outer scope', e)
        process.exit(1);
    }
})();