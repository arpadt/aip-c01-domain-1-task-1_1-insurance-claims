import os
import json
import boto3

websocket_endpoint = os.environ['WEBSOCKET_API_ENDPOINT']
claims_table = os.environ['CLAIMS_TABLE_NAME']

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(claims_table)
apigw_client = boto3.client(
    'apigatewaymanagementapi',
    endpoint_url=websocket_endpoint
)

def handler(event, context):
    for record in event['Records']:
        if record['eventName'] == 'INSERT':
            data = json.dumps(record['dynamodb']['NewImage'])

            try:
                response = table.query(
                    KeyConditionExpression='PK = :pk',
                    ExpressionAttributeValues={':pk': 'CONNECTIONS'})
            except Exception as e:
                print(f'Error while getting connection id from table: {e}')

            items = response['Items']
            if len(items):
                for item in response['Items']:
                    connection_id = item['ConnectionId']
                    try:
                        apigw_client.post_to_connection(ConnectionId=connection_id, Data=data)
                        print(f'Summary data sent to client. Connection id: {connection_id}. Data: {data}')
                    except apigw_client.exceptions.GoneException:
                        table.delete_item(Key={'PK': 'CONNECTION', 'SK': connection_id})
                        print(f'No data sent to client. Connection id: {connection_id}')
            else:
                print('No client connections established')
