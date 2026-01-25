import { useState, useEffect, useRef } from 'react';

const API_URL = import.meta.env.VITE_CLAIMS_API_URL;
const WS_URL = import.meta.env.VITE_CLAIMS_WS_URL;

interface ClaimSummary {
  ClaimId: { S: string };
  Summary: { S: string };
  Type: { S: string };
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [claims, setClaims] = useState<ClaimSummary[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => console.log('WebSocket connected');

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('WS data: ', data);
      if (data.Type?.S === 'ClaimSummary') {
        setClaims((prev) => [data, ...prev]);
      }
    };

    ws.onerror = (error) => console.error('WebSocket error:', error);
    ws.onclose = () => console.log('WebSocket disconnected');

    wsRef.current = ws;

    return () => ws.close();
  }, []);

  const handleUpload = async () => {
    if (!file) {
      setMessage('Please select a file');
      return;
    }

    setUploading(true);
    setMessage('');

    try {
      const response = await fetch(
        `${API_URL}/process?key=${encodeURIComponent(file.name)}`,
      );
      if (!response.ok) {
        throw new Error('Failed to get presigned URL');
      }

      const { url } = await response.json();
      console.log('presigned url: ', url);

      const uploadResponse = await fetch(url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });

      if (!uploadResponse.ok) {
        throw new Error('Upload failed');
      }

      setMessage('Claim uploaded successfully');
      setFile(null);
    } catch (error) {
      setMessage(
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className='min-h-screen bg-gray-50 py-8 px-4'>
      <div className='max-w-4xl mx-auto space-y-6'>
        <div className='bg-white rounded-lg shadow p-8'>
          <h1 className='text-3xl font-bold text-gray-900 mb-6'>
            Insurance Claim Upload
          </h1>
          <div className='space-y-4'>
            <input
              type='file'
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              disabled={uploading}
              className='block w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-gray-50 focus:outline-none'
            />
            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              className='px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed'
            >
              {uploading ? 'Uploading...' : 'Upload Claim'}
            </button>
          </div>
          {message && <p className='mt-4 text-sm text-gray-700'>{message}</p>}
        </div>

        <div className='bg-white rounded-lg shadow p-8'>
          <h2 className='text-2xl font-bold text-gray-900 mb-4'>
            Claims Summary
          </h2>
          {claims.length === 0 ? (
            <p className='text-gray-500'>No claims processed yet</p>
          ) : (
            <div className='space-y-4'>
              {claims.map((claim, idx) => (
                <div
                  key={idx}
                  className='border border-gray-200 rounded-lg p-4'
                >
                  <p className='font-semibold text-gray-900'>
                    Claim ID: {claim.ClaimId.S}
                  </p>
                  <p className='mt-2 text-gray-700'>
                    Claim Summary: {claim.Summary.S}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
