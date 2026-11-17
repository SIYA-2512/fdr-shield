import axios from 'axios';

const rawBaseUrl =
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.PROD ? 'https://fdr-shield-backend.onrender.com/api' : '/api');

const cleanBaseUrl = rawBaseUrl.replace(/\/+$/, '');
const baseURL =
  cleanBaseUrl.startsWith('http') && !cleanBaseUrl.endsWith('/api')
    ? `${cleanBaseUrl}/api`
    : cleanBaseUrl || '/api';

const api = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach JWT token from localStorage to every outgoing request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('fdr_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Catch 401 unauthorized to automatically clear session
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('fdr_token');
      localStorage.removeItem('fdr_user');
    }
    return Promise.reject(error);
  }
);

export default api;
