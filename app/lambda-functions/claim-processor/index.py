import boto3
import json
import os
import uuid
import time

# Initialize clients
s3 = boto3.client('s3')
bedrock_runtime = boto3.client('bedrock-runtime')
dynamodb = boto3.resource('dynamodb')

model_id = os.environ['EXTRACTION_MODEL_ID']
claims_table_name = os.environ['CLAIMS_TABLE_NAME']
guardrail_id = os.environ['GUARDRAIL_ID']
guardrail_version = os.environ['GUARDRAIL_VERSION']

claims_table = dynamodb.Table(claims_table_name)

def handler(event, context):
    if not guardrail_id or not guardrail_version:
        raise ValueError('Guardrail configuration is required but not provided')
    # Get document from S3
    bucket = event['Records'][0]['s3']['bucket']['name']
    key = event['Records'][0]['s3']['object']['key']

    try:
        s3_response = s3.get_object(Bucket=bucket, Key=key)
        document_text = s3_response['Body'].read().decode('utf-8')
    except Exception as e:
        print(f'Error processing document {key} from bucket {bucket}: {e}')
        raise

    # Create prompt for information extraction
    prompt = f"""
    Extract the following information from this insurance claim document:
    - Claimant Name
    - Policy Number
    - Incident Date
    - Claim Amount
    - Incident Description

    Document:
    {document_text}

    Return the information in JSON format. You MUST use a predefined format.

    Example:

    If the extracted information is:

    - Claimant Name: John Doe
    - Policy Number: 1234
    - Incident Date: 01/01/2026
    - Claim Amount: $1,500
    - Incident Description: An incident ...

    then the JSON format MUST look like as follows:

    {{
        "claimant_name": "John Doe",
        "policy_number": "1234",
        "incident_date": "01/01/2026",
        "claim_amount": "$1,500",
        "incident_description": "An incident ..."
    }}
    """

    # Invoke Bedrock model
    try:
        extraction_response = bedrock_runtime.invoke_model(
            modelId=model_id,
            guardrailIdentifier=guardrail_id,
            guardrailVersion=guardrail_version,
            body=json.dumps({
                "schemaVersion": "messages-v1",
                "messages": [{
                    "role": "user",
                    "content": [{"text": prompt}]
                }],
                "inferenceConfig": {
                    "maxTokens": 1000,
                    "temperature": 0.0
                },
                "amazon-bedrock-guardrailConfig": {}
            })
        )
    except Exception as e:
        print(f'Error extracting info from claims document: {e}')
        raise

    # Parse response
    extraction_response_body = json.loads(extraction_response['body'].read())
    extracted_info = json.loads(extraction_response_body['output']['message']['content'][0]['text'])

    # summarizaton time
    start_time = time.time()

    # Generate summary
    summary_prompt = f"""
    Based on this extracted information:
    {extracted_info}

    Generate a concise summary of the claim.
    """

    try:
        summary_response = bedrock_runtime.invoke_model(
            modelId=model_id,
            guardrailIdentifier=guardrail_id,
            guardrailVersion=guardrail_version,
            body=json.dumps({
                "schemaVersion": "messages-v1",
                "messages": [{
                    "role": "user",
                    "content": [{"text": summary_prompt}]
                }],
                "inferenceConfig": {
                    "maxTokens": 500,
                    "temperature": 0.7
                },
                "amazon-bedrock-guardrailConfig": {}
            })
        )
    except Exception as e:
        print(f'Error while summarizing the claim: {e}')
        raise

    elapsed_time = round((time.time() - start_time) * 1000)
    summary_body = json.loads(summary_response['body'].read())
    summary = summary_body['output']['message']['content'][0]['text']

    invocation_info = extraction_response_body['usage']
    try:
        claimant_name = extracted_info['claimant_name']
        policy_number = extracted_info['policy_number']
        claim_id = str(uuid.uuid4())

        ddb_response = claims_table.put_item(Item={
            'PK': f'CLAIMANTNAME#{claimant_name}',
            'SK': f'CLAIMID#{claim_id}',
            'ClaimId': claim_id,
            'PolicyNumber': f'POLICY_NUMBER#{policy_number}',
            'Summary': summary,
            'ModelId': model_id,
            'SummaryLength': str(len(summary)),
            'InputTokens': str(invocation_info['inputTokens']),
            'OutputTokens': str(invocation_info['outputTokens']),
            'SummarizationTimeMilliSeconds': str(elapsed_time),
            'Type': 'ClaimSummary',
        })
    except Exception as e:
        print('Error while persisting summary: {e}')
        raise
