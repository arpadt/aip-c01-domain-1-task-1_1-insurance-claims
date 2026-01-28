import * as cdk from 'aws-cdk-lib/core';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
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

    const claimsBucket = new s3.Bucket(this, 'ClaimsBucket', {
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    const claimsTable = new dynamodb.Table(this, 'ClaimsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    const guardrail = new bedrock.CfnGuardrail(this, 'ClaimsGuardrail', {
      name: 'insurance-claims-guardrail',
      blockedInputMessaging: 'Sensitive information detected in input',
      blockedOutputsMessaging: 'Sensitive information detected in output',
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          {
            type: 'AGE',
            action: 'ANONYMIZE',
            inputAction: 'ANONYMIZE',
            outputAction: 'ANONYMIZE',
            inputEnabled: true,
            outputEnabled: true,
          },
          {
            type: 'EMAIL',
            action: 'ANONYMIZE',
            inputAction: 'ANONYMIZE',
            outputAction: 'ANONYMIZE',
            inputEnabled: true,
            outputEnabled: true,
          },
          {
            type: 'PHONE',
            action: 'ANONYMIZE',
            inputAction: 'ANONYMIZE',
            outputAction: 'ANONYMIZE',
            inputEnabled: true,
            outputEnabled: true,
          },
          {
            type: 'ADDRESS',
            action: 'ANONYMIZE',
            inputAction: 'ANONYMIZE',
            outputAction: 'ANONYMIZE',
            inputEnabled: true,
            outputEnabled: true,
          },
        ],
      },
    });

    const guardrailVersion = new bedrock.CfnGuardrailVersion(
      this,
      'ClaimsGuardrailVersion',
      {
        guardrailIdentifier: guardrail.attrGuardrailId,
        description:
          'Version with AGE, EMAIL, PHONE, ADDRESS masking enabled for input and output',
      },
    );

    const knowledgeBaseSource = new s3.Bucket(
      this,
      'ClaimsKnowledgeBaseSource',
    );
    const vectorBucket = new s3vectors.CfnVectorBucket(
      this,
      'ClaimsVectorBucket',
    );

    const vectorIndex = new s3vectors.CfnIndex(this, 'ClaimsIndex', {
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      indexName: 'claims-index',
      dataType: 'float32',
      dimension: 1024,
      distanceMetric: 'cosine',
      metadataConfiguration: {
        nonFilterableMetadataKeys: [
          'AMAZON_BEDROCK_TEXT',
          'AMAZON_BEDROCK_METADATA',
        ],
      },
    });
    vectorIndex.addDependency(vectorBucket);

    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      inlinePolicies: {
        BedrockModelAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [
                `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
              ],
            }),
          ],
        }),
        S3VectorsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                's3vectors:PutVectors',
                's3vectors:GetVectors',
                's3vectors:DeleteVectors',
                's3vectors:QueryVectors',
                's3vectors:GetIndex',
              ],
              resources: [`${vectorBucket.attrVectorBucketArn}/index/*`],
            }),
          ],
        }),
        S3DataSourceAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:ListBucket'],
              resources: [knowledgeBaseSource.bucketArn],
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetObject'],
              resources: [knowledgeBaseSource.arnForObjects('*')],
            }),
          ],
        }),
      },
    });

    const knowledgeBase = new bedrock.CfnKnowledgeBase(
      this,
      'ClaimsKnowledgeBase',
      {
        name: 'claims-kb',
        roleArn: kbRole.roleArn,
        knowledgeBaseConfiguration: {
          type: 'VECTOR',
          vectorKnowledgeBaseConfiguration: {
            embeddingModelArn: `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
          },
        },
        storageConfiguration: {
          type: 'S3_VECTORS',
          s3VectorsConfiguration: {
            vectorBucketArn: vectorBucket.attrVectorBucketArn,
            indexArn: vectorIndex.attrIndexArn,
          },
        },
      },
    );
    knowledgeBase.addDependency(vectorIndex);

    new bedrock.CfnDataSource(this, 'PolicyDataSource', {
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      name: 'HealthClaimsPolicyDataSource',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: knowledgeBaseSource.bucketArn,
        },
      },
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
      timeout: cdk.Duration.seconds(30),
      environment: {
        EXTRACTION_MODEL_ID: inferenceProfileId,
        CLAIMS_TABLE_NAME: claimsTable.tableName,
        GUARDRAIL_ID: guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: guardrailVersion.attrVersion,
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        SUMMARIZATION_MODEL_ARN: `arn:aws:bedrock:${region}:${account}:inference-profile/eu.amazon.nova-micro-v1:0`,
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
        conditions: {
          StringLike: {
            'bedrock:GuardrailIdentifier': `arn:aws:bedrock:${region}:${account}:guardrail/${guardrail.attrGuardrailId}:*`,
          },
        },
      }),
    );
    claimProcessorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:GetInferenceProfile'],
        resources: [
          `arn:aws:bedrock:*:${account}:inference-profile/${inferenceProfileId}`,
        ],
      }),
    );
    claimProcessorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ApplyGuardrail'],
        resources: [
          `arn:aws:bedrock:${region}:${account}:guardrail/${guardrail.attrGuardrailId}`,
        ],
      }),
    );
    claimProcessorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:RetrieveAndGenerate', 'bedrock:Retrieve'],
        resources: [
          `arn:aws:bedrock:${region}:${account}:knowledge-base/${knowledgeBase.attrKnowledgeBaseId}`,
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
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
        statusCode: 200,
      },
    });
    const processResource = restApi.root.addResource('process');
    const processIntegration = new apigateway.LambdaIntegration(presignedUrlFn);
    const processGetEndpoint = processResource.addMethod(
      'GET',
      processIntegration,
    );
    processGetEndpoint.addMethodResponse({
      statusCode: '200',
      responseParameters: {
        'method.response.header.Access-Control-Allow-Origin': true,
      },
    });

    const webSocketApi = new apigatewayv2.WebSocketApi(
      this,
      'InsuranceClaimsWebSocketApi',
    );
    const webSocketStage = new apigatewayv2.WebSocketStage(
      this,
      'WebSocketStage',
      {
        webSocketApi,
        stageName: 'prod',
        autoDeploy: true,
      },
    );

    const connectHandlerFn = new lambda.Function(this, 'ConnectHandlerFn', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('app/lambda-functions/websocket-connect'),
      environment: {
        CLAIMS_TABLE_NAME: claimsTable.tableName,
      },
    });
    claimsTable.grantWriteData(connectHandlerFn);

    const disconnectHandlerFn = new lambda.Function(
      this,
      'DisconnectHandlerFn',
      {
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(
          'app/lambda-functions/websocket-disconnect',
        ),
        environment: {
          CLAIMS_TABLE_NAME: claimsTable.tableName,
        },
      },
    );
    claimsTable.grantWriteData(disconnectHandlerFn);

    webSocketApi.addRoute('$connect', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'ConnectIntegration',
        connectHandlerFn,
      ),
    });
    webSocketApi.addRoute('$disconnect', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'DisconnectIntegration',
        disconnectHandlerFn,
      ),
    });

    const streamHandlerLogGroup = new logs.LogGroup(
      this,
      'StreamHandlerLogGroup',
      {
        retention: logs.RetentionDays.FIVE_DAYS,
      },
    );

    const streamHandlerFn = new lambda.Function(this, 'StreamHandlerFn', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('app/lambda-functions/stream-handler'),
      logGroup: streamHandlerLogGroup,
      environment: {
        CLAIMS_TABLE_NAME: claimsTable.tableName,
        WEBSOCKET_API_ENDPOINT: `https://${webSocketApi.apiId}.execute-api.${region}.amazonaws.com/${webSocketStage.stageName}`,
      },
    });

    streamHandlerFn.addEventSource(
      new DynamoEventSource(claimsTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        filters: [
          lambda.FilterCriteria.filter({
            dynamodb: {
              NewImage: {
                Type: {
                  S: lambda.FilterRule.isEqual('ClaimSummary'),
                },
              },
            },
          }),
        ],
      }),
    );

    claimsTable.grantReadData(streamHandlerFn);
    streamHandlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [
          `arn:aws:execute-api:${region}:${account}:${webSocketApi.apiId}/${webSocketStage.stageName}/POST/@connections/*`,
        ],
      }),
    );
  }
}
