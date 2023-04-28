#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsOrganizationsVendingMachineStack } from '../lib/aws-organizations-vending-machine-stack';
import {CleanUpMavmAccountsStack} from "../lib/clean-up-mavm-accounts-stack";

const app = new cdk.App();
new CleanUpMavmAccountsStack(app, 'CleanUpMavmAccountsStack', {env: {region: 'eu-west-1'}});
