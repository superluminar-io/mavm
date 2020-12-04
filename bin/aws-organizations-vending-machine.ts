#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AwsOrganizationsVendingMachineStack } from '../lib/aws-organizations-vending-machine-stack';

const app = new cdk.App();
new AwsOrganizationsVendingMachineStack(app, 'AwsOrganizationsVendingMachineStack');
