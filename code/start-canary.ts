import * as AWS from 'aws-sdk';

exports.handler = async (event: any, context: any, callback: any) => {
    const cws: AWS.Synthetics = new AWS.Synthetics();
    await cws.startCanary({Name: <string>process.env['CANARY_NAME']}).promise();
}