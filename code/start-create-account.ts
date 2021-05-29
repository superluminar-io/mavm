import * as AWS from "aws-sdk";
const { v4: uuidv4 } = require('uuid');
const util = require('util');
import { SQSEvent, SQSHandler} from 'aws-lambda';
const codebuild: AWS.CodeBuild = new AWS.CodeBuild();

export const handler: SQSHandler = async (event: SQSEvent) => {
    event.Records[0]

    const CODEBUILD_PROJECT_NAME = <string>process.env['CODEBUILD_PROJECT_NAME'];

    const random_suffix = uuidv4().split('-')[0];
    const account_email = `superwerker-aws-test+${random_suffix}@superluminar.io`;
    const account_name = util.format('ovm-%s', random_suffix);

    await codebuild.startBuild(
        {
            projectName: CODEBUILD_PROJECT_NAME,
            environmentVariablesOverride: [
                {
                    name: 'ACCOUNT_NAME',
                    value: account_name
                },
                {
                    name: 'ACCOUNT_EMAIL',
                    value: account_email
                },
            ],
        }
    ).promise();
}