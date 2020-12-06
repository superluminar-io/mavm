import * as AWS from 'aws-sdk';

const cws: AWS.Synthetics = new AWS.Synthetics();

export async function handler(): Promise<void> {
    // @ts-ignore
    await cws.startCanary({Name: process.env['CANARY_NAME']}).promise()
}