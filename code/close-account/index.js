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

    browser.close();
};

async function closeAccount(page) {
    await page.goto('https://console.aws.amazon.com/billing/home?#/account', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });

    await page.waitForTimeout(8000);

    let closeaccountcbs = await page.$$('.close-account-checkbox > input');
    await closeaccountcbs.forEach(async (cb) => {
        await cb.evaluate((e) => e.click());
        await page.waitForTimeout(1000);
    });

    await page.waitForTimeout(5000);

    await page.click('.btn-danger'); // close account button

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
        page.waitForSelector('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary');
        await page.click('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary');
        await page.waitForTimeout(5000);
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
        page.waitForSelector('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary');
        await page.click('#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary');
        await page.waitForTimeout(5000);
    } catch (e) {
    }

    // edit the management account
    const managementAccountCheckbox = await page.$x('//div[@class="tax-table-cell ng-binding" and text()="' + ACCOUNT_NAME + '"]/preceding-sibling::div//input[@type="checkbox"]')
    await managementAccountCheckbox[0].click();
    await page.waitForTimeout(1000);

    // click edit
    const manage_tax_registration_button = '#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > div:nth-child(2) > div:nth-child(1) > awsui-button-dropdown > div > button';
    await page.waitForSelector(manage_tax_registration_button)
    await page.click(manage_tax_registration_button)
    const edit_link = '#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > div:nth-child(2) > div:nth-child(1) > awsui-button-dropdown > div > div > ul > li:nth-child(1) > a';
    await page.waitForSelector(edit_link)
    await page.click(edit_link)

    // country "select" box
    const country_selector = '#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > awsui-modal:nth-child(6) > div.awsui-modal-__state-showing.awsui-modal-container > div > div > div.awsui-modal-body > div > span > form > awsui-control-group:nth-child(2) > div > div > div.awsui-control-group-control > span > awsui-select > span > span';
    await page.waitForSelector(country_selector)
    await page.click(country_selector)
    await page.waitForTimeout(1000);
    await page.type(country_selector, secretdata.country)
    await page.waitForTimeout(1000);
    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > awsui-modal:nth-child(6) > div.awsui-modal-__state-showing.awsui-modal-container > div > div > div.awsui-modal-body > div > span > form > awsui-control-group:nth-child(2) > div > div > div.awsui-control-group-control > span > awsui-select > span > div > div > ul > li.awsui-select-option.awsui-select-option-highlight')
    await page.waitForTimeout(1000);

    // tax id
    await page.type('#awsui-textfield-1', secretdata.vatid)
    await page.waitForTimeout(1000);

    // legal entity
    await page.type('#awsui-textfield-2', secretdata.company)
    await page.waitForTimeout(1000);

    await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > awsui-modal:nth-child(6) > div.awsui-modal-__state-showing.awsui-modal-container > div > div > div.awsui-modal-footer > div > span > awsui-button:nth-child(1) > button')
    await page.waitForTimeout(5000);

    try {
        await page.waitForSelector('#heritageCheckbox input', {timeout: 5000});

        const taxInheritanceEnabled = await page.$eval('#heritageCheckbox input', check => { return check.checked});
        if (taxInheritanceEnabled) {
            console.log('tax inheritance already enabled');
            return;
        }

        await page.click('#heritageCheckbox > label > div')
        await page.waitForTimeout(1000);

        await page.click('#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div > div > div > div > div.margin-top-20 > div:nth-child(1) > awsui-modal:nth-child(7) > div.awsui-modal-__state-showing.awsui-modal-container > div > div > div.awsui-modal-footer > div > span > awsui-button:nth-child(1) > button')
        await page.waitForTimeout(5000);
    } catch (e) {
        console.log('no tax inheritance, apparently because there are no sub-accounts');
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