//import * as AWS from 'aws-sdk';
//const cws: AWS.Synthetics = new AWS.Synthetics();
const { v4: uuidv4 } = require('uuid');
const util = require('util');

exports.handler = async (event: any, context: any, callback: any) => {
    // @ts-ignore
    const randomSuffix = uuidv4().split('-')[0];
    const ACCOUNT_EMAIL = `superwerker-aws-test+${randomSuffix}@superluminar.io`; // TODO: this has to be generated from a subdomain which is under control so we can close the account automatically
    const ACCOUNT_NAME = util.format('ovm-%s', randomSuffix);

    //await cws.startCanary({Name: process.env['CANARY_NAME']}).promise()
    return {
        'accountEmail': ACCOUNT_EMAIL,
        'accountName': ACCOUNT_NAME,
    };
    callback(null, {
        'accountEmail': ACCOUNT_EMAIL,
        'accountName': ACCOUNT_NAME,
    });
}