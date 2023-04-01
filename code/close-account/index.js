// Adapted from and proudly found elsewhere at https://github.com/iann0036/aws-account-controller
// special thanks to Ian McKay
const AWS = require('aws-sdk');
const puppeteer = require('puppeteer');
let lastPage = null;

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

    const password = await getPassword(ACCOUNT_NAME, secretdata);

    try {
        await loginToAccount(page, ACCOUNT_EMAIL, password, secretdata.twocaptcha_apikey);

        await removeCookieBanner(page);

        await enableTaxInheritance(page, secretdata, ACCOUNT_NAME);

        await closeAccount(page);

        await markAccountDeleted(ACCOUNT_NAME);
    } catch (e) {
        switch (e.message) {
            case "account_closed":
                console.log("Ignoring error: Account already closed", e)
                await markAccountDeleted(ACCOUNT_NAME, e);
                break
            case "password_reset_required":
                console.log("Ignoring error: Cannot close account", e)
                await markAccountFailure(ACCOUNT_NAME, e);
                break;
            default:
                throw e;
        }
    }

    await browser.close();
};

async function getPassword(account_name, secretdata) {
    const ddb = new AWS.DynamoDB();
    const result = await ddb.getItem({
        Key: {
            account_name: {
                S: account_name
            }
        },
        TableName: 'account',
    }).promise();

    if(result.Item && result.Item.password && result.Item.password.S) {
        console.log('using password from dynamodb', result.Item.password.S)
        return result.Item.password.S;
    }
    console.log('using default password', secretdata.password)
    return secretdata.password
}

async function removeCookieBanner(page) {
    // remove cookie banner so that it's possible to click on the submit button later, otherwise the UI thinks the button cannot be clicked
    await page.$eval(
        "#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary",
        (e) => e.click()
    );
    await page.waitForTimeout(5000);
}

async function closeAccount(page) {
    lastPage = page;
    await page.goto('https://console.aws.amazon.com/billing/home?#/account', {
        timeout: 0,
        waitUntil: ['domcontentloaded']
    });

    await page.click('button[data-testid="aws-billing-account-form-button-close-account"]:first-child'); // close account button

    let account_closed = false;
    const confirm_close_account = 'button[data-testid="aws-billing-account-modal-button-close-account"]';
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

async function tryToSolveCaptcha(page, twocaptcha_apikey) {
    try {
        await page.waitForSelector("#captchaGuess", {
            timeout: 5000,
            visible: true,
        });
    } catch (e) {
        console.log("captcha input did not show up in time", e);
        return;
    }

    captchanotdone = true;
    captchaattempts = 0;
    while (captchanotdone) {
        captchaattempts += 1;
        if (captchaattempts > 6) {
            throw new Error("too_many_attempts");
        }

        await page.waitForTimeout(3000); // wait for captcha_image to be loaded
        let recaptchaimg = await page.$("#captcha_image");
        let recaptchaurl = await page.evaluate((obj) => {
            return obj.getAttribute("src");
        }, recaptchaimg);

        let captcharesult = await solveCaptcha2captcha(
            page,
            recaptchaurl,
            twocaptcha_apikey
        );
        console.log("captcharesult", captcharesult);

        let input2 = await page.$("#captchaGuess");

        await input2.press("Backspace");
        await input2.type(captcharesult, {delay: 100});

        await page.waitForTimeout(3000);

        await page.click("#submit_captcha");

        await page.waitForTimeout(5000);

        let passwordResetRequired = false;
        try {
            // further logins to this account require a password reset first
            await page.waitForXPath("//span[@id='error_title' and contains(text(),'Password reset is required')]", {timeout: 5000});
            passwordResetRequired = true;
        } catch (e) {
            // all good
        }
        if (passwordResetRequired) {
            throw new Error("password_reset_required");
        }

        let errormessagediv = await page.$("#error_message");
        let errormessagedivstyle = await page.evaluate((obj) => {
            return obj.getAttribute("style");
        }, errormessagediv);

        if (errormessagedivstyle.includes("display: none")) {
            captchanotdone = false;
        }
        await page.waitForTimeout(2000);
    }
}

async function loginToAccount(
    page,
    ACCOUNT_EMAIL,
    password,
    twocaptcha_apikey
) {
    lastPage = page;
    // log in to get account id
    await page.goto("https://console.aws.amazon.com/console/home", {
        timeout: 0,
        waitUntil: ["domcontentloaded"],
    });
    await page.waitForSelector("#resolving_input", { timeout: 15000 });
    await page.waitForTimeout(500);

    let resolvinginput = await page.$("#resolving_input");
    await resolvinginput.press("Backspace");
    await resolvinginput.type(ACCOUNT_EMAIL, { delay: 100 });

    await page.click("#next_button");

    await tryToSolveCaptcha(page, twocaptcha_apikey);

    let input4 = await page.$("#password");
    await input4.press("Backspace");
    await input4.type(password, { delay: 100 });

    await page.click("#signin_button");

    await tryToSolveCaptcha(page, twocaptcha_apikey);

    await page.waitForTimeout(8000);

    let accountClosedFromTheBillingConsole = false;
    try {
        // account has already been closed from the billing console
        await page.waitForXPath("//span[contains(text(),'You closed your AWS account from the Account and Billing Console.')]", {timeout: 5000});
        accountClosedFromTheBillingConsole = true;
    } catch (e) {
        // all good
    }
    if (accountClosedFromTheBillingConsole) {
        throw new Error("account_closed");
    }
}

async function enableTaxInheritance(page, secretdata, account_name) {
    lastPage = page;
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
    // await page.waitForXPath('//td//span[text()="' + account_name + '"]/parent::span/parent::td//parent::tr//input');
    // const managementAccountCheckbox = await page.$x('//td//span[text()="' + account_name + '"]/parent::span/parent::td//parent::tr//input');
    // await managementAccountCheckbox[0].click();
    // await page.waitForTimeout(1000);


    await page.waitForSelector('awsui-button-dropdown[data-testid="manage-tax-reg-button"] button:first-child');
    await page.click('awsui-button-dropdown[data-testid="manage-tax-reg-button"] button:first-child');
    await page.waitForTimeout(1000);

    try {
        await page.waitForSelector('li[data-testid="edit_all_button"]');
        await page.click('li[data-testid="edit_all_button"]');
        await page.waitForTimeout(1000);

        // wait until tax form shows up
        await page.waitForSelector('div[data-testid="tax-form-page"]')

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

        // next
        await page.waitForSelector('awsui-wizard[data-testid="tax-wizard"] .awsui-wizard__primary-button button:first-child');
        await page.click('awsui-wizard[data-testid="tax-wizard"] .awsui-wizard__primary-button button:first-child');

        // confirm
        await page.waitForTimeout(5000); // wait for checkbox to be clickable
        await page.waitForSelector('awsui-wizard[data-testid="tax-wizard"] .awsui-wizard__primary-button button:first-child');
        await page.click('awsui-wizard[data-testid="tax-wizard"] .awsui-wizard__primary-button button:first-child');

        // confirm again
        await page.waitForSelector('awsui-button[data-testid="modal-submit-button"] button:first-child');
        await page.click('awsui-button[data-testid="modal-submit-button"] button:first-child');
    } catch (e) {
        console.log('could not edit tax registration, either it is already filled in or there is some problem', e);

        // sanity check that vatid is set
        await page.waitForXPath('//td//span[text()="' + secretdata.vatid + '"]', {timeout: 5000});
    }

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


async function markAccountDeleted(ACCOUNT_NAME, error) {
    const ddb = new AWS.DynamoDB();
    await ddb.updateItem({
        Key: {
            account_name: {
                S: ACCOUNT_NAME
            }
        },
        TableName: 'account',
        UpdateExpression: "SET error_message = :error_message, deletion_date = :deletion_date, account_status = :account_status",
        ExpressionAttributeValues: {
            ":error_message": {
                S: error ? error.toString() : '',
            },
            ":deletion_date": {
                S: new Date().toISOString()
            },
            ":account_status": {
                S: 'CLOSED'
            },

        },
    }).promise();
}

async function markAccountFailure(ACCOUNT_NAME, error) {
    const ddb = new AWS.DynamoDB();
    await ddb.updateItem({
        Key: {
            account_name: {
                S: ACCOUNT_NAME
            }
        },
        TableName: 'account',
        UpdateExpression: "SET error_message = :error_message, failure_date = :failure_date, account_status = :account_status",
        ExpressionAttributeValues: {
            ":error_message": {
                S: error ? error.toString() : '',
            },
            ":failure_date": {
                S: new Date().toISOString()
            },
            ":account_status": {
                S: 'FAILED'
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
        console.log(e);

        // once we are timed out we can't do anything with puppeteer anymore...
        //if (!(e instanceof puppeteer.TimeoutError)) {
            if (lastPage) {
                console.log("taking screenshots...");
                await lastPage.screenshot({
                    path: "failed.jpg",
                });

                //const content = await lastPage.content();
                //console.log(content);
            }
        //}
        process.exit(1);
    }
})();