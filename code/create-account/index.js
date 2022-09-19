// Adapted from and proudly found elsewhere at https://github.com/iann0036/aws-account-controller
// special thanks to Ian McKay
const AWS = require("aws-sdk");
const fs = require("fs");
const util = require("util");
const puppeteer = require("puppeteer");
const {getDocument, queries} = require('pptr-testing-library')
const passwordGenerator = require("generate-password");

const CONNECT_SSM_PARAMETER = "/superwerker/tests/connect"; // TODO: rename
const PRINCIPAL = process.env["PRINCIPAL"];
const INVOICE_EMAIL = process.env["INVOICE_EMAIL"];
const INVOICE_CURRENCY = process.env["INVOICE_CURRENCY"];

const ACCOUNT_NAME = process.env["ACCOUNT_NAME"];
const ACCOUNT_EMAIL = process.env["ACCOUNT_EMAIL"];

const QUEUE_URL_3D_SECURE = process.env["QUEUE_URL_3D_SECURE"];
const QUEUE_URL_MAIL_VERIFICATION = process.env["QUEUE_URL_MAIL_VERIFICATION"];
const BUCKET_FOR_TRANSCRIBE = process.env["BUCKET_FOR_TRANSCRIBE"];
let pageFoo = null;

async function checkIfAccountIsReady(accountId) {
  const sts = new AWS.STS();

  const roleArnToAssume = util.format(
    "arn:aws:iam::%s:role/OVMCrossAccountRole",
    accountId
  );

  const assumedRoleCreds = await sts
    .assumeRole({
      RoleArn: roleArnToAssume,
      RoleSessionName: "mavm-test",
      DurationSeconds: 900,
    })
    .promise();

  const roleCreds = {
    accessKeyId: assumedRoleCreds.Credentials.AccessKeyId,
    secretAccessKey: assumedRoleCreds.Credentials.SecretAccessKey,
    sessionToken: assumedRoleCreds.Credentials.SessionToken,
  };

  const cloudformation = new AWS.CloudFormation({ credentials: roleCreds });

  // this is a smoke test if the cross account role has been set up
  const cfnResult = await cloudformation.listStacks().promise();
}

const signup = async function () {
  const secretsmanager = new AWS.SecretsManager();
  let secretsmanagerresponse = await secretsmanager
    .getSecretValue({
      SecretId: "/aws-organizations-vending-machine/ccdata",
    })
    .promise();
  let secretdata = JSON.parse(secretsmanagerresponse.SecretString);

  // generate password according to the IAM rules
  const password = passwordGenerator.generate({
    length: 16,
    uppercase: true,
    lowercase: true,
    numbers: true,
    symbols: "!@#$%^&*()_+-=[]{}|",
  });

  const ssm = new AWS.SSM({ region: "us-east-1" });

  let connectssmparameter = await ssm
    .getParameter({
      Name: CONNECT_SSM_PARAMETER,
    })
    .promise();

  let variables = JSON.parse(connectssmparameter["Parameter"]["Value"]);

  let browser;
  // Check if we are running locally
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    browser = await puppeteer.launch({
      devtools: false,
      headless: true,
      args: [
        "--disable-audio-output",
        "--no-sandbox",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });
  } else {
    browser = await puppeteer.launch({
      args: [
        "--disable-audio-output",
        "--no-sandbox",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });
  }

  const page = await browser.newPage();

  // remove indicators that we are running headless
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await page.setUserAgent(userAgent.replace("Headless", ""));

  await signupPageOne(page, ACCOUNT_EMAIL, password, ACCOUNT_NAME);

  await signupPageTwo(page, secretdata);

  await signupCreditCard(page, secretdata, QUEUE_URL_3D_SECURE);

  await signupVerification(page, variables, ACCOUNT_NAME, ssm);

  await loginToAccount(
    page,
    ACCOUNT_EMAIL,
    password,
    secretdata.twocaptcha_apikey
  );

  await createCrossAccountRole(page, PRINCIPAL);

  await billingInformation(page, INVOICE_CURRENCY, INVOICE_EMAIL);

  const accountId = await getAccountId(page);

  await checkIfAccountIsReady(accountId);

  await saveAccountIdAndFinish(
    ACCOUNT_NAME,
    ACCOUNT_EMAIL,
    accountId,
    password
  );

  await browser.close();
};

const httpGet = (url) => {
  const https = require("https");
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
};

const httpGetBinary = (url) => {
  const https = require("https");
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        //res.setEncoding('binary');
        var data = [];
        res.on("data", (chunk) => data.push(chunk));
        res.on("end", () => resolve(Buffer.concat(data)));
      })
      .on("error", reject);
  });
};

async function solveAudioCaptcha(audioCaptchaUrl, ACCOUNT_NAME) {
  const s3 = new AWS.S3();
  const transcribe = new AWS.TranscribeService();

  let audioCaptchaUrlResult = await httpGetBinary(audioCaptchaUrl);
  let audioCaptchaUrlTempDir = fs.mkdtempSync("/tmp/audiocaptcha");
  let audioCaptchaUrlFilename = audioCaptchaUrlTempDir + "/audiocaptcha.mp3";
  fs.writeFileSync(audioCaptchaUrlFilename, audioCaptchaUrlResult);

  const { v4: uuidv4 } = require("uuid");
  const randomSuffix = uuidv4().split("-")[0];
  const transcriptionJobName = ACCOUNT_NAME + randomSuffix;
  const s3Key = transcriptionJobName + ".mp3";
  const s3Bucket = BUCKET_FOR_TRANSCRIBE;
  await s3
    .upload({
      Bucket: s3Bucket,
      Body: fs.readFileSync(audioCaptchaUrlFilename),
      Key: s3Key,
    })
    .promise();

  let audioCaptchaS3Uri = `s3://${s3Bucket}/${s3Key}`;
  await transcribe
    .startTranscriptionJob({
      TranscriptionJobName: transcriptionJobName,
      Media: {
        MediaFileUri: audioCaptchaS3Uri,
      },
      LanguageCode: "en-US",
    })
    .promise();

  let transScribeJobfinished = false;
  let transScribeResultUrl = "";
  while (!transScribeJobfinished) {
    let transScribeJob = await transcribe
      .getTranscriptionJob({
        TranscriptionJobName: transcriptionJobName,
      })
      .promise();
    if (
      transScribeJob.TranscriptionJob.TranscriptionJobStatus === "COMPLETED"
    ) {
      transScribeResultUrl =
        transScribeJob.TranscriptionJob.Transcript.TranscriptFileUri;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000)); // one does not simply sleep() in node
  }

  let data = await httpGet(transScribeResultUrl);
  let audioCaptchaTranscribeResult = JSON.parse(data);

  let solvedAudioCaptcha = "";

  audioCaptchaTranscribeResult.results.items.forEach((item) => {
    function wordsToNumbers(content) {
      const numbers = [
        "zero",
        "one",
        "two",
        "three",
        "for",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
      ];
      const key = numbers.indexOf(content.toLowerCase());
      if (key !== -1) {
        return key;
      }
      return "";
    }

    if (!isNaN(parseInt(item.alternatives[0].content))) {
      solvedAudioCaptcha += item.alternatives[0].content;
    } else {
      solvedAudioCaptcha += wordsToNumbers(item.alternatives[0].content);
    }
  });
  console.debug("Resolved audio captcha: " + solvedAudioCaptcha);
  return solvedAudioCaptcha;
}

async function loginToAccount(
  page,
  ACCOUNT_EMAIL,
  password,
  twocaptcha_apikey
) {
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

  let solveCaptcha = false;
  try {
    await page.waitForSelector("#captchaGuess", {
      timeout: 5000,
      visible: true,
    });
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
      let recaptchaimg = await page.$("#captcha_image");
      let recaptchaurl = await page.evaluate((obj) => {
        return obj.getAttribute("src");
      }, recaptchaimg);

      let captcharesult = await solveCaptcha2captcha(
        page,
        recaptchaurl,
        twocaptcha_apikey
      );

      let input2 = await page.$("#captchaGuess");

      await input2.press("Backspace");
      await input2.type(captcharesult, { delay: 100 });

      await page.waitForTimeout(3000);

      await page.click("#submit_captcha");

      await page.waitForTimeout(5000);

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

  let input4 = await page.$("#password");
  await input4.press("Backspace");
  await input4.type(password, { delay: 100 });

  await page.click("#signin_button");
  await page.waitForTimeout(8000);
}

async function signupVerification(page, variables, ACCOUNT_NAME, ssm) {
  await page.waitForTimeout(10000); // wait for redirects to finish

  await page.click('input[name="divaMethod"][value="Phone"]:first-child');
  await page.waitForTimeout(1000);

  var phonecode = "";
  var phonecodetext = "";

  let captchanotdone = true;
  let captchaattemptsfordiva = 0;
  while (captchanotdone) {
    captchaattemptsfordiva += 1;
    if (captchaattemptsfordiva > 10) {
      throw "Could not confirm phone number verification - possible error in DIVA system or credit card";
    }

    let portalphonenumber = await page.$(
      'input[name="phoneNumber"]:first-child'
    );
    await portalphonenumber.click({ clickCount: 3 }); // clear input
    await portalphonenumber.press("Backspace");

    const connectClient = new AWS.Connect({ region: "us-east-1" });
    const availablePhoneNumbers = (
      await connectClient
        .listPhoneNumbers({ InstanceId: process.env["CONNECT_INSTANCE_ID"] })
        .promise()
    )["PhoneNumberSummaryList"];
    const randomPhoneNumber =
      availablePhoneNumbers[
        Math.floor(Math.random() * availablePhoneNumbers.length)
      ].PhoneNumber;
    console.log(
      `chosen (#${captchaattemptsfordiva}) random phone number:`,
      randomPhoneNumber
    );

    await portalphonenumber.type(randomPhoneNumber.replace("+1", ""), {
      delay: 100,
    });

    await page.waitForTimeout(3000); // wait for captcha_image to be loaded

    const captchaResponse = page.waitForResponse((response) => {
      return response
        .url()
        .startsWith("https://opfcaptcha-prod.s3.amazonaws.com/");
    });

    await page.waitForSelector(
      'img[alt="Change to audio security check"]:first-child'
    );
    await page.click('img[alt="Change to audio security check"]:first-child');
    await page.waitForTimeout(1000);

    await page.waitForSelector('span[aria-label="Play Audio"]');
    await page.click('span[aria-label="Play Audio"]');

    await page.waitForTimeout(1000);

    const audioCaptchaUrl = (await captchaResponse).url();
    console.log("Audio captcha URL:", audioCaptchaUrl);

    let solvedAudioCaptcha = await solveAudioCaptcha(
      audioCaptchaUrl,
      ACCOUNT_NAME
    );

    let input32 = await page.$('input[name="captchaGuess"]:first-child');
    await input32.press("Backspace");
    await input32.type(solvedAudioCaptcha, { delay: 100 });
    await page.waitForTimeout(1000);

    let submitc = await page.$(
      "#IdentityVerification > fieldset > awsui-button > button"
    );
    await submitc.click();

    try {
      await page.waitForSelector("#phonePin", { timeout: 5000 });
      phonecode = await page.$("#phonePin");
      phonecodetext = await page.evaluate((el) => el.textContent, phonecode);

      if (phonecodetext.trim().length == 4) {
        captchanotdone = false;
      } else {
        await page.waitForTimeout(5000);
      }
    } catch (error) {
      console.log("captcha probably not done, continue", error);
    }
  }

  variables["CODE"] = phonecodetext;

  await ssm
    .putParameter({
      Name: CONNECT_SSM_PARAMETER,
      Type: "String",
      Value: JSON.stringify(variables),
      Overwrite: true,
    })
    .promise();

  // wait for amazon connect to answer the call
  await page.waitForSelector(
    "#SupportPlan > fieldset > div.CenteredButton_centeredButtonContainer_3Xaah > awsui-button > button",
    { timeout: 120000 }
  );
  await page.click(
    "#SupportPlan > fieldset > div.CenteredButton_centeredButtonContainer_3Xaah > awsui-button > button"
  );

  // "Go to the AWS Management Console" selector
  await page.waitForSelector(
    "#aws-signup-app > div > div.App_content_5H0by > div > div > div:nth-child(5) > awsui-button > a"
  );
}

async function getAccountId(page) {
  await page.goto("https://console.aws.amazon.com/billing/rest/v1.0/account", {
    timeout: 0,
    waitUntil: ["domcontentloaded"],
  });
  await page.waitForTimeout(3000);
  const innerText = await page.evaluate(
    () => document.querySelector("pre").innerText
  );
  const account = JSON.parse(innerText);
  return account["accountId"];
}

async function saveAccountIdAndFinish(
  ACCOUNT_NAME,
  ACCOUNT_EMAIL,
  accountId,
  password
) {
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
        "SET account_id = :account_id, account_email = :account_email, registration_date = :registration_date, account_status = :account_status, password = :password",
      ExpressionAttributeValues: {
        ":account_id": {
          S: accountId,
        },
        ":account_email": {
          S: ACCOUNT_EMAIL,
        },
        ":registration_date": {
          S: new Date().toISOString(),
        },
        ":account_status": {
          S: "CREATED",
        },
        ":password": {
          S: password,
        },
      },
    })
    .promise();
}

async function solveCaptcheHandler(
  page,
  account_name,
  selector,
  selectorComplete
) {
  console.log("Trying to solve captcha");

  captchanotdone = true;
  captchaattempts = 0;
  while (captchanotdone) {
    captchaattempts += 1;
    if (captchaattempts > 6) {
      return;
    }

    await page.waitForTimeout(3000); // wait for captcha_image to be loaded

    const captchaResponse = page.waitForResponse((response) => {
      return response
        .url()
        .startsWith("https://opfcaptcha-prod.s3.amazonaws.com/");
    });

    await page.waitForSelector(
      'img[alt="Change to audio security check"]:first-child'
    );
    await page.click('img[alt="Change to audio security check"]:first-child');
    await page.waitForTimeout(1000);

    await page.waitForSelector('span[aria-label="Play Audio"]');
    await page.click('span[aria-label="Play Audio"]');

    await page.waitForTimeout(1000);

    const audioCaptchaUrl = (await captchaResponse).url();
    console.log("Audio captcha URL:", audioCaptchaUrl);

    let solvedAudioCaptcha = await solveAudioCaptcha(
      audioCaptchaUrl,
      account_name
    );

    let input2 = await page.$('input[name="captchaGuess"]:first-child');

    await input2.press("Backspace");
    await input2.type(solvedAudioCaptcha, { delay: 100 });

    await page.waitForTimeout(3000);

    await page.click(selector);

    try {
      await page.waitForSelector(selectorComplete, {
        timeout: 10000,
      });
      captchanotdone = false;
    } catch {
      console.log("captcha not solved, trying again");
    }
  }
}

async function signupPageOne(page, ACCOUNT_EMAIL, password, ACCOUNT_NAME) {
  pageFoo = page;

  await page.goto("https://portal.aws.amazon.com/billing/signup#/start");
  await page.waitForSelector("#awsui-input-0", { timeout: 15000 });

  page.screenshot({
    path: "page-1-start.jpg",
  });

  // remove cookie banner so that it's possible to click on the submit button later, otherwise the UI thinks the button cannot be clicked
  await page.$eval(
    "#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary",
    (e) => e.click()
  );

  await page.waitForSelector('input[name="emailAddress"]:first-child');
  await page.type('input[name="emailAddress"]:first-child', ACCOUNT_EMAIL);
  await page.waitForTimeout(1000);

  let accountNameSelector = await page.$('input[name="fullName"]:first-child');
  await page.waitForTimeout(1000);
  await accountNameSelector.click({ clickCount: 3 });
  await accountNameSelector.type(ACCOUNT_NAME);
  await page.waitForTimeout(1000);

  await page.click("#EmailValidationSendOTP button:first-child");

  let solveCaptcha = false;
  try {
    await page.waitForSelector("#captchaGuess", {
      timeout: 5000,
      visible: true,
    });
    console.log("trying to solve captcha");
    solveCaptcha = true;
  } catch (e) {
    // continue normal flow
  }

  if (solveCaptcha) {
    await solveCaptcheHandler(
      page,
      ACCOUNT_NAME,
      "#EmailValidationSendOTP > fieldset > awsui-button > button",
      "#EmailValidationVerifyOTP"
    );
  }

  // retrieve SMS result from SQS queue
  const sqs = new AWS.SQS();
  const sqsMessage = await sqs
    .receiveMessage({
      QueueUrl: QUEUE_URL_MAIL_VERIFICATION,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
    })
    .promise();

  if (typeof sqsMessage.Messages === "undefined") {
    throw "Could not read signup confirmation code mail from SQS queue.";
  }

  const sqsMessageBody = JSON.parse(sqsMessage.Messages[0].Body);
  const sqsMessageS3 = sqsMessageBody.Records[0].s3;

  const s3 = new AWS.S3();
  const mailMessage = await s3
    .getObject({
      Bucket: sqsMessageS3.bucket.name,
      Key: sqsMessageS3.object.key,
    })
    .promise();
  const mail = mailMessage.Body.toString("utf-8");
  await sqs
    .deleteMessage({
      QueueUrl: QUEUE_URL_MAIL_VERIFICATION,
      ReceiptHandle: sqsMessage.Messages[0].ReceiptHandle,
    })
    .promise();

  const verificationCode = mail.match(/Verification code:\s*([\d]+)/ms)[1];
  await page.type("#otp input:first-child", verificationCode);
  await page.waitForTimeout(1000);
  await page.click("#EmailValidationVerifyOTP button:first-child");

  await page.waitForSelector('input[name="password"]:first-child');
  await page.type('input[name="password"]:first-child', password);
  await page.waitForTimeout(1000);
  await page.type('input[name="rePassword"]:first-child', password);
  await page.waitForTimeout(1000);

  await page.click("#CredentialCollection button:first-child");
  await page.waitForTimeout(5000);
  await page.click(
    "#CredentialCollection > fieldset > awsui-button:nth-child(7) > button"
  );

  page.screenshot({
    path: "page-1-end.jpg",
  });
}

async function signupPageTwo(page, secretdata) {
  pageFoo = page;

  page.screenshot({
    path: "page-2-start.jpg",
  });

  await page.waitForTimeout(1000);

  let foundButton = false;
  let foundCaptcha = false;

  try {
    await page.waitForSelector("#awsui-radio-button-1", { timeout: 5000 });
    foundButton = true;
  } catch (e) {}

  if (foundButton === false) {
    try {
      await page.waitForSelector("#captchaGuess", {
        timeout: 5000,
        visible: true,
      });
      foundCaptcha = true;
    } catch (e) {}
  }

  if (foundCaptcha) {
    await solveCaptcheHandler(
      page,
      ACCOUNT_NAME,
      "#CredentialCollection button[type=submit]",
      "#awsui-radio-button-1"
    );
  }

  await page.screenshot({
    path: "page-2-captcha-button.jpg",
  });

  await page.click("#awsui-radio-button-1");

  await page.waitForTimeout(1000);

  await page.type(
    'input[name="address.fullName"]:first-child',
    secretdata.company
  );
  await page.waitForTimeout(1000);

  await page.type(
    'input[name="address.company"]:first-child',
    secretdata.company
  );
  await page.waitForTimeout(1000);

  const connectClient = new AWS.Connect({ region: "us-east-1" });
  const availablePhoneNumbers = (
    await connectClient
      .listPhoneNumbers({ InstanceId: process.env["CONNECT_INSTANCE_ID"] })
      .promise()
  )["PhoneNumberSummaryList"];
  const randomPhoneNumber =
    availablePhoneNumbers[
      Math.floor(Math.random() * availablePhoneNumbers.length)
    ].PhoneNumber;
  console.log("chosen random phone number:", randomPhoneNumber);

  await page.type(
    'input[name="address.phoneNumber"]:first-child',
    randomPhoneNumber
  );
  await page.waitForTimeout(1000);

  await page.click("#awsui-select-2 > div > awsui-icon > span"); // click country selection
  await page.waitForTimeout(1000);
  // await page.waitForSelector("#awsui-input-8", {visible:true, timeout: 5000});
  // await page.focus("#awsui-input-8");
  // await page.waitForTimeout(1000);
  // await page.type("#awsui-input-8", secretdata.country);

  const $document = await getDocument(page);
  const [$countryInput] = (await queries.getAllByLabelText($document,'Country or Region')).slice(-1);
  await $countryInput.type(secretdata.country)

  await page.waitForTimeout(1000);
  await page.click(
    "#awsui-select-2-dropdown-option-0 > div > div > div > span > span"
  );
  await page.waitForTimeout(1000);

  await page.type(
    'input[name="address.addressLine1"]:first-child',
    secretdata.streetaddress
  );
  await page.waitForTimeout(1000);

  await page.type('input[name="address.city"]:first-child', secretdata.city);
  await page.waitForTimeout(1000);

  await page.type('input[name="address.state"]:first-child', secretdata.state);
  await page.waitForTimeout(1000);

  await page.type(
    'input[name="address.postalCode"]:first-child',
    secretdata.postalcode
  );
  await page.waitForTimeout(1000);

  await page.click('input[name="agreement"]:first-child');
  await page.waitForTimeout(1000);

  await page.click("#ContactInformation > fieldset > awsui-button > button");
  await page.waitForTimeout(1000);
}

async function signupCreditCard(page, secretdata, queueUrl3dSecure) {
  await page.waitForSelector('input[name="cardNumber"]:first-child');

  let input5 = await page.$('input[name="cardNumber"]:first-child');
  await input5.press("Backspace");
  await input5.type(secretdata.ccnumber, { delay: 100 });
  await page.waitForTimeout(1000);

  await page.click("#awsui-select-3 > div > awsui-icon > span"); // click month selection
  await page.waitForTimeout(1000);

  const ccExpireDate = new Date(secretdata.ccyear, secretdata.ccmonth - 1, 1);
  const ccExpireMonthName = ccExpireDate.toLocaleString("default", {
    month: "long",
  });

  await (
    await page.$x(
      '//*[@id = "awsui-select-3-dropdown-options"]//span[text() = "' +
        ccExpireMonthName +
        '"]'
    )
  )[0].click();
  await page.waitForTimeout(1000);

  await page.click("#awsui-select-4 > div > awsui-icon > span"); // click year selection
  await page.waitForTimeout(1000);

  await (
    await page.$x(
      '//*[@id = "awsui-select-4-dropdown-options"]//span[text() = "' +
        secretdata.ccyear +
        '"]'
    )
  )[0].click();
  await page.waitForTimeout(1000);

  let input6 = await page.$('input[name="accountHolderName"]:first-child');
  await input6.press("Backspace");
  await input6.type(secretdata.ccname, { delay: 100 });
  await page.waitForTimeout(2000);

  await page.click("#PaymentInformation > fieldset > awsui-button > button");
  await page.waitForTimeout(1000);

  if (queueUrl3dSecure) {
    // 3D-Secure
    await page.waitForNavigation({ waitUntil: "networkidle0" });

    try {
      await page.waitForSelector(
        'input[name="divaMethod"][value="Phone"]:first-child',
        { timeout: 5000 }
      );
      console.log("3D Secure check not requested, skipping");
      return;
    } catch (e) {}

    const frame3DSecureElement = await page.waitForSelector(
      "iframe:first-child"
    );
    const frame3DSecure = await frame3DSecureElement.contentFrame();
    const tan3dSecureSelector = await frame3DSecure.waitForSelector(
      "#challengeDataEntry",
      {
        timeout: 20000,
        visible: true,
      }
    );

    // retrieve SMS result from SQS queue
    const sqs = new AWS.SQS();
    let sqsMessage;
    let sqsMessageAttempts = 0;
    while (sqsMessageAttempts < 10) {
      sqsMessageAttempts += 1;
      console.log(`Trying to get SQS message with 3d secure code for credit card, attempt #${sqsMessageAttempts}` );
      sqsMessage = await sqs
          .receiveMessage({
            QueueUrl: queueUrl3dSecure,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
          })
          .promise();
      if (typeof sqsMessage.Messages != "undefined") {
        break;
      }
    }

    if (typeof sqsMessage.Messages === "undefined") {
      throw "Could not read 3d secure tan from SQS queue.";
    }

    // the following code is specific to Amazon DE Credit Card and needs to be adapted to other CC providers

    // credit card tan
    const tan3dSecure = sqsMessage.Messages[0].Body.substr(0, 6);
    await tan3dSecureSelector.type(tan3dSecure, { delay: 300 });
    await page.waitForTimeout(5000);
    await frame3DSecure.click("#confirm");

    // Credit Card Pin
    await frame3DSecure.waitForNavigation({ waitUntil: "networkidle0" });
    const tan3dSecurePinSelector = await frame3DSecure.waitForSelector(
      "#challengeDataEntry",
      {
        timeout: 20000,
        visible: true,
      }
    );
    await tan3dSecurePinSelector.type(secretdata.cc_pin, { delay: 300 });
    await page.waitForTimeout(5000);
    await frame3DSecure.click("#confirm");
    await page.waitForTimeout(5000);
  }
}

async function createCrossAccountRole(page, PRINCIPAL) {
  // remove cookie banner so that it's possible to click on the submit button later, otherwise the UI thinks the button cannot be clicked
  await page.$eval(
    "#awsccc-cb-buttons > button.awsccc-u-btn.awsccc-u-btn-primary",
    (e) => e.click()
  );
  await page.waitForTimeout(5000);

  const crossAccountRole = "OVMCrossAccountRole";

  let init = util.format(
    "https://console.aws.amazon.com/iamv2/home#/roles/create?awsAccount=%s&step=review&trustedEntityType=AWS_ACCOUNT",
    PRINCIPAL
  );

  // log in to get account id
  await page.goto(init, {
    timeout: 0,
    waitUntil: ["domcontentloaded"],
  });

  const nextButtonSelector =
    "#role-creation-wizard > div > div.awsui-wizard__column-form > div.wizard-step.wizard-step__active > awsui-form > div > div.awsui-form-actions > span > div > awsui-button.awsui-wizard__primary-button > button";
  await page.waitForSelector(nextButtonSelector, { timeout: 15000 });
  await page.click(nextButtonSelector);

  await page.waitForSelector("#awsui-autosuggest-0", { timeout: 5000 });
  await page.click("#awsui-autosuggest-0");
  await page.waitForTimeout(2000);
  await page.type("#awsui-autosuggest-0", "AdministratorAccess");
  await page.waitForTimeout(1000);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);

  await page.waitForSelector("#awsui-checkbox-1", { timeout: 5000 });
  const checkbox = await page.$(
    "#RoleCreate-AttachPoliciesTable > awsui-table > div > div.awsui-table-container > table > tbody > tr:nth-child(1) > td.awsui-table-selection-area > awsui-checkbox input"
  );
  await checkbox.evaluate((b) => b.click());

  await page.waitForTimeout(2000);
  await page.waitForSelector(nextButtonSelector, { timeout: 5000 });
  await page.click(nextButtonSelector);

  await page.waitForSelector("#awsui-input-0", { timeout: 5000 });
  await page.type("#awsui-input-0", crossAccountRole);

  await page.waitForTimeout(2000);
  await page.waitForSelector(nextButtonSelector, { timeout: 5000 });
  await page.click(nextButtonSelector);

  await page.waitForTimeout(10000);
}

async function billingInformation(page, INVOICE_CURRENCY, INVOICE_EMAIL) {
  await page.setViewport({ width: 1366, height: 2000 });
  await page.goto("https://console.aws.amazon.com/billing/home?#/account");
  await page.waitForTimeout(3000);
  await page.waitForSelector("#account__edit-currency-preference");
  await page.click("#account__edit-currency-preference");

  await page.waitForTimeout(3000);
  await page.waitForSelector("#account__select-currencies-list");
  await page.waitForTimeout(3000);
  await page.select("#account__select-currencies-list", INVOICE_CURRENCY);

  await page.waitForTimeout(3000);
  await page.click(
    "#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(3) > div > div > div > div.account-information-update-buttons.margin-top-10 > button.btn.btn-primary"
  );
  await page.waitForTimeout(3000);

  await page.click(
    "#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > a"
  );
  await page.waitForTimeout(3000);
  await page.type(
    "#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > div > div > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(1) > input",
    "Bill Gates"
  );
  await page.waitForTimeout(1000);
  await page.type(
    "#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > div > div > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(2) > input",
    "CFO"
  );
  await page.waitForTimeout(1000);
  await page.type(
    "#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > div > div > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(3) > input",
    INVOICE_EMAIL
  );
  await page.waitForTimeout(1000);
  await page.type(
    "#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > div > div > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(4) > input",
    "+1234567890"
  );
  await page.waitForTimeout(1000);
  await page.click(
    "#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.animation-content.animation-fade > div:nth-child(4) > div > div > div > div.account-information-update-buttons.margin-top-10.ng-scope > button.btn.btn-primary"
  );
  await page.waitForTimeout(3000);

  await page.goto("https://console.aws.amazon.com/billing/home?#/preferences");
  await page.waitForTimeout(3000);
  await page.click(
    "#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.plutonium.aws-billing-console-root.awsui-v1-root > div > div > div.aws-billing-console-span10 > div:nth-child(2) > div > label > span > i"
  );
  await page.waitForTimeout(3000);
  await page.click(
    "#billing-console-root > div > div > div > div.content--2j5zk.span10--28Agl > div > div > div > div > div > div.ng-scope > div > div > div > div.aws-billing-console-span10 > div.plutonium.aws-billing-console-root.awsui-v1-root > div > div > button"
  );
  await page.waitForTimeout(3000);
}

const solveCaptcha2captcha = async (page, url, twocaptcha_apikey) => {
  var imgbody = await httpGetBinary(url).then((res) => {
    return res;
  });

  var captcharef = await httpPostJson("https://2captcha.com/in.php", {
    key: twocaptcha_apikey,
    method: "base64",
    body: imgbody.toString("base64"),
  }).then((res) => {
    console.log("2Captcha: " + res);
    return res.split("|").pop();
  });

  var captcharesult = "";
  var i = 0;
  while (!captcharesult.startsWith("OK") && i < 20) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5000);
    });

    captcharesult = await httpGet(
      "https://2captcha.com/res.php?key=" +
        twocaptcha_apikey +
        "&action=get&id=" +
        captcharef
    ).then((res) => {
      return res;
    });

    i++;
  }

  return captcharesult.split("|").pop();
};

const httpPostJson = (url, postData) => {
  const https = require("https");
  var querystring = require("querystring");

  postData = querystring.stringify(postData);

  var options = {
    method: "POST",
  };

  return new Promise((resolve, reject) => {
    let req = https.request(url, options);
    req.on("response", (res) => {
      //If the response status code is not a 2xx success code
      if (res.statusCode < 200 || res.statusCode > 299) {
        reject("Failed: " + options.path);
      }

      res.setEncoding("utf8");
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
};

(async () => {
  try {
    await signup();
  } catch (e) {
    console.log(e);

    if (pageFoo) {
      await pageFoo.screenshot({
        path: "failed.jpg",
      });

      const content = await pageFoo.content();
      console.log(content);
    }

    console.log("got exception in outer scope", e);
    process.exit(1);
  }
})();
