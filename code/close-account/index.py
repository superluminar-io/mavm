from awsapilib import AccountManager, Billing
from awsapilib.captcha import Captcha2
import awsapilib.console.consoleexceptions
import boto3
import json
import os
import time
import datetime

import logging
logging.basicConfig(level=logging.INFO)

account_name = os.environ['ACCOUNT_NAME']
account_email = os.environ['ACCOUNT_EMAIL']

ddb = boto3.client('dynamodb')
account_info = ddb.get_item(TableName='account', Key={'account_name': {"S": account_name}})['Item']
account_id = account_info['account_id']['S']

sm = boto3.client('secretsmanager')
secret_values = json.loads(sm.get_secret_value(SecretId='/aws-organizations-vending-machine/ccdata')['SecretString'])


solver = Captcha2(api_key=secret_values['twocaptcha_apikey'])

try:
    account_manager = AccountManager(account_email, secret_values['password'], 'eu-west-1', solver=solver)

    account_manager.iam.billing_console_access = True
    time.sleep(10)

    admin_role = 'arn:aws:iam::{}:role/OVMCrossAccountRole'.format(account_id)
    billing = Billing(admin_role)

    billing.tax.inheritance = True
    time.sleep(10)

    # Set tax information
    billing.tax.set_information(secret_values['streetaddress'], secret_values['city'], secret_values['postalcode'], secret_values['company'], secret_values['vatid'], secret_values['countrycode'])
    billing.preferences.pdf_invoice_by_mail = True

    account_manager.terminate_account()
except awsapilib.console.consoleexceptions.InvalidAuthentication as e:
    if not "Suspended" in str(e):
        raise e
    logging.info("Account probably already closed, doing nothing")

ddb.update_item(
    Key={
        "account_name": {
            "S": account_name
        }
    },
    TableName='account',
    UpdateExpression="SET deletion_date = :deletion_date, account_status = :account_status",
    ExpressionAttributeValues={
        ":deletion_date": {
            "S": datetime.datetime.utcnow().isoformat()
        },
        ":account_status": {
            "S": 'CLOSED'
        },

    }
)
