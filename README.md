# Welcome to the AWS Management Account Vending Machine (MAVM)

Create new AWS management accounts on the fly and clean up and close accounts afterwards again. Fully automated.

Special thanks for inspiration and parts of the code go to [Ian McKay](https://onecloudplease.com/blog/) and his [AWS Account Controller](https://github.com/iann0036/aws-account-controller).

## How it works

The MAVM consists of three parts: AWS account creation, AWS account deletion, and AWS account vending API. The status of AWS accounts is tracked in a DynamoDB table.

### AWS account creation

The MAVM ensures that several AWS accounts are in stock and ready to be vended.

1. A scheduled Step Function checks via a Lambda function whether there are enough created AWS accounts in stock. The Lambda returns an array of account name/email pairs to be created, if necessary.
1. The Step Function iterates over the array.
1. Each iteration starts a CodeBuild project (`code/create-account`) which tries to create a new AWS account via Puppeteer:<br>
   It registers with company and credit card data, which are stored in AWS Secrets Manager.<br>
   It solves audio captchas with Amazon Transcribe.<br>
   Phone verification is done via Amazon Connect.
1. A cross-account IAM role with `AdministratorAccess` is created so that clients can programmatically interact with the account.
1. Billing information is set: currency, invoice via email, billing contact email address.
1. The account is written to a DynamoDB table, ready to be "vended".

### AWS account vending

An API is created for AWS account vending.

1. A client requests an account at `https://XXXXXXXXX.execute-api.eu-west-1.amazonaws.com/vend`.
1. The MAVM returns a created account and marks it as vended in the database.

The response is a JSON:

```JSON
{
    "account_id": "123456789012",
    "cross_account_role": "arn:aws:iam::123456789012:role/OVMCrossAccountRole"
}
```

### AWS account deletion

1. Once an AWS account is vended via the MAVM API, a Step Function is started, which waits 24 hours (via a DynamoDB stream).
1. The Step Function synchronously triggers a CodeBuild project (with lots of retries).
1. The CodeBuild project runs a Puppeteer script which logs in into the AWS console, optionally solves a captcha via 2captcha (no audio captcha available here), enables tax inheritance (to enable one bill per AWS organization), and closes the account. The account is marked as deleted in the DynamoDB database.

## Installation

TODO

## Developing // Debugging

### Start account creation locally

```
export RANDOM_VALUE=$RANDOM; export ACCOUNT_EMAIL=root+$RANDOM_VALUE@<your_test_domain>; export ACCOUNT_NAME=ovm-$RANDOM_VALUE; echo $ACCOUNT_EMAIL;  PRINCIPAL=<principal account id> INVOICE_EMAIL=<some_email_adress> INVOICE_CURRENCY=EUR CONNECT_INSTANCE_ID=<amazon connect instance id> QUEUE_URL_3D_SECURE=... BUCKET_FOR_TRANSCRIBE=... QUEUE_URL_MAIL_VERIFICATION=... AWS_SDK_LOAD_CONFIG=1 node index.js
```

## Caveats and known issues

- AWS account deletion fails if an AWS Organization with sub-accounts has been created. We are eagerly waiting for an AWS Organizations Account suspension API, which would solve this problem.
- The API is not secured with authentication currently
- Credit card 3D-Secure authentication implementation is currently mandatory and specific to german Amazon credit card. It can be adapted to other credit card issuers, though.
