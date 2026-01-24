import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

interface InsuranceClaimsStackProps extends cdk.StackProps {
  env: {
    account: string | undefined;
    region: string | undefined;
  };
}

const modelId = 'amazon.nova-micro-v1:0';
const inferenceProfileId = 'eu.amazon.nova-micro-v1:0';

export class InsuranceClaimsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: InsuranceClaimsStackProps) {
    super(scope, id, props);

    const { account, region } = props?.env ?? {};

    if (!account && !region) {
      throw new Error('Basic stack configurations missing');
    }

    const claimsBucket = new s3.Bucket(this, 'ClaimsBucket');

    const claimsTable = new dynamodb.Table(this, 'ClaimsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const presignedUrlLogGroup = new logs.LogGroup(
      this,
      'PresignedUrlLogGroup',
      {
        retention: logs.RetentionDays.FIVE_DAYS,
      },
    );

    const presignedUrlFn = new lambda.Function(this, 'PresignedUrlFn', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('app/lambda-functions/presigned-url'),
      logGroup: presignedUrlLogGroup,
      environment: {
        CLAIMS_BUCKET_NAME: claimsBucket.bucketName,
      },
    });
    presignedUrlFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [claimsBucket.arnForObjects('*')],
      }),
    );

    const claimProcessorLogGroup = new logs.LogGroup(
      this,
      'ClaimProcessorLogGroup',
      {
        retention: logs.RetentionDays.FIVE_DAYS,
      },
    );

    const claimProcessorFn = new lambda.Function(this, 'ClaimProcessorFn', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('app/lambda-functions/claim-processor'),
      logGroup: claimProcessorLogGroup,
      environment: {
        EXTRACTION_MODEL_ID: inferenceProfileId,
        CLAIMS_TABLE_NAME: claimsTable.tableName,
      },
    });
    claimProcessorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [claimsBucket.arnForObjects('*')],
      }),
    );
    claimProcessorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:*::foundation-model/${modelId}`,
          `arn:aws:bedrock:*:${account}:inference-profile/${inferenceProfileId}`,
        ],
      }),
    );
    claimProcessorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [claimsTable.tableArn],
      }),
    );

    claimsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(claimProcessorFn),
    );

    const restApi = new apigateway.RestApi(this, 'InsuranceClaimsApi', {
      endpointTypes: [apigateway.EndpointType.REGIONAL],
    });
    const processResource = restApi.root.addResource('process');
    const processIntegration = new apigateway.LambdaIntegration(presignedUrlFn);
    processResource.addMethod('GET', processIntegration);
  }
}
