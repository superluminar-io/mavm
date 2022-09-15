import * as AWS from 'aws-sdk'
const { v4: uuidv4 } = require('uuid')
const util = require('util')
const dynamoDB: AWS.DynamoDB.DocumentClient = new AWS.DynamoDB.DocumentClient()
import { Context, Callback } from 'aws-lambda'

const ACCOUNT_ROOT_EMAIL_PATTERN = <string>process.env['ACCOUNT_ROOT_EMAIL_PATTERN']

exports.handler = async (event: any, context: Context, callback: Callback) => {
  const accounts_to_vend = parseInt(<string>process.env['ACCOUNTS_TO_VEND'])

  let account_vending_list = []

  for (let i = 0; i < accounts_to_vend; ++i) {
    const random_suffix = uuidv4().split('-')[0]
    const account_email = util.format(ACCOUNT_ROOT_EMAIL_PATTERN, random_suffix)
    const account_name = util.format('ovm-%s', random_suffix)

    const account_to_create = {
      account_name: account_name,
      account_email: account_email,
    }
    account_vending_list.push(account_to_create)
  }

  callback(null, account_vending_list)
}
