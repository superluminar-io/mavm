# Welcome to the AWS Management Account Vending Machine (MAVM)

Create new AWS management accounts on the fly and clean up and close accounts afterwards again. Fully automated.

Special thanks for inspiration and parts of the code go to [Ian McKay](https://onecloudplease.com/blog/) and his [AWS Account Controller](https://github.com/iann0036/aws-account-controller), and the [awsapilib](https://awsapilib.readthedocs.io/en/latest/).

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

### Account creation locally (with debugging)
- this will use the pre-installed MAVN
- and start the flow in a chromium browser

```sh
cd code/create-account
npm i
# on Mac arm64 run it as follows and download chromium upfront via 'brew install --cask chromium'
# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm i

export DOMAIN="" # the TLD you use as root mail address
export AWS_MAVM_ACCOUNT_REGION=""; # the region where MAVM is deployed
export AWS_MAVM_ACCOUNT_PROFILE=""; # the profile you want to use in the account where MAVM is deployed
export AWS_CODEBUILD_PROJECT_NAME=""; # name of the codebuild 'CreateAccountCodeProject-<random>' project. see in the console
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true; # as we already downloaded the binary
export PUPPETEER_EXECUTABLE_PATH=$(which chromium); # we use chromium here
# now we set all the needed environment variables
export QUEUE_URL_MAIL_VERIFICATION=$(aws --profile $AWS_MAVM_ACCOUNT_PROFILE codebuild batch-get-projects --names $AWS_CODEBUILD_PROJECT_NAME --query "projects[0].environment.environmentVariables[?name=='QUEUE_URL_MAIL_VERIFICATION'].value" --output text);
export BUCKET_FOR_TRANSCRIBE=$(aws --profile $AWS_MAVM_ACCOUNT_PROFILE codebuild batch-get-projects --names $AWS_CODEBUILD_PROJECT_NAME --query "projects[0].environment.environmentVariables[?name=='BUCKET_FOR_TRANSCRIBE'].value" --output text);
export QUEUE_URL_3D_SECURE=$(aws --profile $AWS_MAVM_ACCOUNT_PROFILE codebuild batch-get-projects --names $AWS_CODEBUILD_PROJECT_NAME --query "projects[0].environment.environmentVariables[?name=='QUEUE_URL_3D_SECURE'].value" --output text);
export CONNECT_INSTANCE_ID=$(aws --profile $AWS_MAVM_ACCOUNT_PROFILE codebuild batch-get-projects --names $AWS_CODEBUILD_PROJECT_NAME --query "projects[0].environment.environmentVariables[?name=='CONNECT_INSTANCE_ID'].value" --output text);
export PRINCIPAL=$(aws --profile $AWS_MAVM_ACCOUNT_PROFILE codebuild batch-get-projects --names $AWS_CODEBUILD_PROJECT_NAME --query "projects[0].environment.environmentVariables[?name=='PRINCIPAL'].value" --output text);
export INVOICE_EMAIL=$(aws --profile $AWS_MAVM_ACCOUNT_PROFILE codebuild batch-get-projects --names $AWS_CODEBUILD_PROJECT_NAME --query "projects[0].environment.environmentVariables[?name=='INVOICE_EMAIL'].value" --output text);
export INVOICE_CURRENCY=$(aws --profile $AWS_MAVM_ACCOUNT_PROFILE codebuild batch-get-projects --names $AWS_CODEBUILD_PROJECT_NAME --query "projects[0].environment.environmentVariables[?name=='INVOICE_CURRENCY'].value" --output text);

RANDOM_VALUE=$(openssl rand -hex 4) \
ACCOUNT_NAME=ovm-$RANDOM_VALUE \
ACCOUNT_EMAIL=root+$RANDOM_VALUE@$DOMAIN \
AWS_REGION=$AWS_TEST_ACCOUNT_REGION \
AWS_SDK_LOAD_CONFIG=1 \
node index.js
```

### Account Creation via triggering Codebuild job
We need this as chromium behaves differently on Mac (for local testing) than on Linux (on which codebuild runs)
- after your local changes ran successfully
- first publish the changes via `yarn cdk deploy` (to be verified)

```sh
export DOMAIN=""; \                     # the TLD you use as root mail address
export AWS_MAVM_ACCOUNT_REGION=""; \    # the region where MAVM is deployed
export AWS_MAVM_ACCOUNT_PROFILE=""; \   # the profile you want to use in the account where MAVM is deployed
export AWS_CODEBUILD_PROJECT_NAME=""; \ # name of the codebuild 'CreateAccountCodeProject-<random>' project. see in the console
export FOO=$(openssl rand -hex 4) \
    && aws codebuild start-build \
        --profile $AWS_MAVM_ACCOUNT_PROFILE \
        --project-name $AWS_CODEBUILD_PROJECT_NAME \
        --region $AWS_MAVM_ACCOUNT_REGION \
        --environment-variables-override \
            "name=ACCOUNT_NAME,value=ovm-${FOO},type=PLAINTEXT" \
            "name=ACCOUNT_EMAIL,value=root+ovm-${FOO}@$DOMAIN,type=PLAINTEXT"
```

### Account closing locally

```
cd code/close-account
pip install -r requirements.txt
ACCOUNT_NAME=<the account name> ACCOUNT_EMAIL=<the account email> python index.py
```

## Caveats and known issues

- AWS account deletion fails if an AWS Organization with sub-accounts has been created. The AWS Organizations `CloseAccount` API does not solve this problem, since it has a hard limit on how many accounts can be closed at once.
- The API is not secured with authentication currently
- Credit card 3D-Secure authentication implementation is currently mandatory and specific to german Amazon credit card. It can be adapted to other credit card issuers, though.
