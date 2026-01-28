import boto3
import json
import os
import uuid
from datetime import datetime

s3 = boto3.client('s3')
bedrock_runtime = boto3.client('bedrock-runtime')
bedrock_agent_runtime = boto3.client('bedrock-agent-runtime')
dynamodb = boto3.resource('dynamodb')

model_id = os.environ['EXTRACTION_MODEL_ID']
claims_table_name = os.environ['CLAIMS_TABLE_NAME']
guardrail_id = os.environ['GUARDRAIL_ID']
guardrail_version = os.environ['GUARDRAIL_VERSION']
knowledge_base_id = os.environ['KNOWLEDGE_BASE_ID']
model_arn = os.environ['SUMMARIZATION_MODEL_ARN']

claims_table = dynamodb.Table(claims_table_name)

def handler(event, context):
    if not guardrail_id or not guardrail_version:
        raise ValueError('Guardrail configuration is required but not provided')

    bucket = event['Records'][0]['s3']['bucket']['name']
    key = event['Records'][0]['s3']['object']['key']

    try:
        s3_response = s3.get_object(Bucket=bucket, Key=key)
        document_text = s3_response['Body'].read().decode('utf-8')
    except Exception as e:
        print(f'Error processing document {key} from bucket {bucket}: {e}')
        raise

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

    You MUST ONLY RETURN the JSON object. Every other text is disallowed.
    """

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

    extraction_response_body = json.loads(extraction_response['body'].read())
    extracted_info = json.loads(extraction_response_body['output']['message']['content'][0]['text'])

    # summarizaton time
    start_time = datetime.now()

    summary_prompt = f"""
    Based on this extracted information:
    {extracted_info}

    Generate a concise summary of the claim.
    """

    try:
        summary_response = bedrock_agent_runtime.retrieve_and_generate(
            input={'text': summary_prompt},
            retrieveAndGenerateConfiguration={
                'type': 'KNOWLEDGE_BASE',
                'knowledgeBaseConfiguration': {
                    'knowledgeBaseId': knowledge_base_id,
                    'modelArn': model_arn,
                    'generationConfiguration': {
                        'guardrailConfiguration': {
                            'guardrailId': guardrail_id,
                            'guardrailVersion': guardrail_version
                        },
                        'inferenceConfig': {
                            'textInferenceConfig': {
                                'maxTokens': 500,
                                'temperature': 0.7
                            }
                        }
                    }
                }
            }
        )
    except Exception as e:
        print(f'Error while summarizing the claim: {e}')
        raise

    end_time = datetime.now()
    elapsed_time = round((end_time - start_time).total_seconds() * 1000)

    summary = summary_response['output']['text']

    timestamp = end_time.replace(microsecond=0).isoformat()

    try:
        claimant_name = extracted_info['claimant_name']
        policy_number = extracted_info['policy_number']
        claim_id = str(uuid.uuid4())

        claims_table.put_item(Item={
            'PK': f'CLAIMANTNAME#{claimant_name}',
            'SK': f'CLAIMID#{claim_id}',
            'ClaimId': claim_id,
            'PolicyNumber': f'POLICY_NUMBER#{policy_number}',
            'Summary': summary,
            'ModelId': model_id,
            'SummaryLength': str(len(summary)),
            'SummarizationTimeMilliSeconds': str(elapsed_time),
            'Type': 'ClaimSummary',
            'TimeStamp': timestamp,
            'GuardrailActionDuringExtraction': {True: 'True', False: 'False'}[extraction_response_body['amazon-bedrock-guardrailAction'] == 'INTERVENED']
        })
    except Exception as e:
        print('Error while persisting summary: {e}')
        raise
