# Welcome to the AWS Organizations Vending Machine (OVM)

Create new AWS accounts and Organizations on the fly and clean up and close accounts afterward again. Fully automated.

Special thanks for inspiration and parts of the code go to [Ian McKay](https://onecloudplease.com/blog/) and his [AWS Account Controller](https://github.com/iann0036/aws-account-controller).

## How it works

The OVM consists of three parts: AWS account creation, AWS account deletion, and AWS account vending API. The status of AWS accounts is tracked in a DynamoDB table.

### AWS account creation

The OVM ensures that several AWS accounts are in stock and ready to be vended.

1. A scheduled Lambda checks if there are enough created AWS accounts in stock. It fills an SQS queue with AWS accounts to be created, if necessary.
1. A regularly scheduled CloudWatch Synthetics canary looks for messages in the SQS queue.
1. If a message is found, it tries to create a new AWS account:<br>
   It registers with company and credit card data, which are stored in AWS Secrets Manager.<br>
   It solves audio captchas with Amazon Transcribe.<br>
   Phone verification is done via Amazon Connect.
1. A cross-account IAM role with `AdministratorAccess` is created so that clients can programmatically interact with the account.
1. Billing information is set: currency, invoice via email, billing contact email address.

### AWS account vending

An API is created for AWS account vending.

1. A client requests an account at `https://XXXXXXXXX.execute-api.eu-west-1.amazonaws.com/vend`.
1. The OVM returns a created account and marks it as vended in the database.

The response is a JSON:

```JSON
{
    "account_id": "123456789012",
    "cross_account_role": "arn:aws:iam::123456789012:role/OVMCrossAccountRole"
}
```

### AWS account deletion

1. Once an AWS account is vended via the OVM API, a Step Function is started, which waits 24 hours (via a DynamoDB stream).
1. The Step Function creates a message in an SQS queue which serves as a buffer and retry handler.
1. A regularly scheduled CWS canary looks for items in the SQS queue
1. If a message is found, the canary logs in into the AWS console and closes the account.
1. The account is marked as deleted in the DynamoDB database.

## Installation

TODO

## Caveats and known issues

- AWS account deletion fails if an AWS Organization with sub-accounts has been created. We are eagerly waiting for an AWS Organizations Account suspension API, which would solve this problem.
- The API is not secured with authentication currently
- No monitoring/alerting for dead-letter queues.
- Overall little error handling. Failed account creation or deletion tries are put into a DLQ but not further handled. 
