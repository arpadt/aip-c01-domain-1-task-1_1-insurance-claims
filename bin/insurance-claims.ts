#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { InsuranceClaimsStack } from '../lib/insurance-claims-stack';

const app = new cdk.App();
new InsuranceClaimsStack(app, 'InsuranceClaimsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
