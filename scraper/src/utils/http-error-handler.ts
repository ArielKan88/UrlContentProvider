import { HttpStatusCode } from '../interfaces/scrape.interface';

export interface HttpErrorResult {
  canRetry: boolean;
  errorMessage: string;
  httpStatus?: number;
  isTemporary: boolean;
}

export class HttpErrorHandler {
  static handle(error: any, response?: any): HttpErrorResult {
    const httpStatus = response?.status() || error?.status || error?.code;
    
    if (typeof httpStatus === 'number') {
      return this.handleHttpStatus(httpStatus, error.message || 'HTTP error');
    }

    // Handle Puppeteer/Chrome network errors
    if (error.message?.includes('net::ERR_')) {
      return this.handleChromeNetworkError(error.message);
    }

    if (error.name === 'TimeoutError' || error.message?.includes('timeout')) {
      return {
        canRetry: true,
        errorMessage: 'Request timeout',
        isTemporary: true,
        httpStatus: HttpStatusCode.TIMEOUT
      };
    }

    // Node.js network errors
    if (error.code === 'ENOTFOUND') {
      return {
        canRetry: false,
        errorMessage: `DNS resolution failed: ${error.code}`,
        isTemporary: false
      };
    }

    if (error.code === 'ECONNREFUSED') {
      return {
        canRetry: true,
        errorMessage: `Connection refused: ${error.code}`,
        isTemporary: true
      };
    }

    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return {
        canRetry: true,
        errorMessage: `Connection error: ${error.code}`,
        isTemporary: true
      };
    }

    return {
      canRetry: true, // Default to retryable for unknown errors
      errorMessage: error.message || 'Unknown error',
      isTemporary: true
    };
  }

  private static handleChromeNetworkError(errorMessage: string): HttpErrorResult {
    // Chrome/Puppeteer network errors
    if (errorMessage.includes('ERR_CONNECTION_REFUSED')) {
      return {
        canRetry: true,
        errorMessage: 'Connection refused',
        isTemporary: true,
        httpStatus: HttpStatusCode.SERVICE_UNAVAILABLE
      };
    }

    if (errorMessage.includes('ERR_CONNECTION_TIMED_OUT') || 
        errorMessage.includes('ERR_TIMED_OUT')) {
      return {
        canRetry: true,
        errorMessage: 'Connection timeout',
        isTemporary: true,
        httpStatus: HttpStatusCode.TIMEOUT
      };
    }

    if (errorMessage.includes('ERR_NAME_NOT_RESOLVED')) {
      return {
        canRetry: false,
        errorMessage: 'DNS resolution failed',
        isTemporary: false,
        httpStatus: HttpStatusCode.NOT_FOUND
      };
    }

    if (errorMessage.includes('ERR_CERT_')) {
      return {
        canRetry: false,
        errorMessage: 'SSL certificate error',
        isTemporary: false,
        httpStatus: HttpStatusCode.BAD_GATEWAY
      };
    }

    if (errorMessage.includes('ERR_NETWORK_CHANGED') || 
        errorMessage.includes('ERR_INTERNET_DISCONNECTED')) {
      return {
        canRetry: true,
        errorMessage: 'Network connectivity issue',
        isTemporary: true,
        httpStatus: HttpStatusCode.SERVICE_UNAVAILABLE
      };
    }

    // Default for other Chrome errors - assume retryable
    return {
      canRetry: true,
      errorMessage: `Chrome network error: ${errorMessage}`,
      isTemporary: true,
      httpStatus: HttpStatusCode.SERVICE_UNAVAILABLE
    };
  }

  private static handleHttpStatus(status: number, message: string): HttpErrorResult {
    switch (status) {
      case HttpStatusCode.OK:
        return {
          canRetry: false,
          errorMessage: 'Success',
          httpStatus: status,
          isTemporary: false
        };

      case HttpStatusCode.BAD_REQUEST:
      case HttpStatusCode.UNAUTHORIZED:
      case HttpStatusCode.FORBIDDEN:
      case HttpStatusCode.NOT_FOUND:
        return {
          canRetry: false,
          errorMessage: `Client error ${status}: ${message}`,
          httpStatus: status,
          isTemporary: false
        };

      case HttpStatusCode.TIMEOUT:
      case HttpStatusCode.TOO_MANY_REQUESTS:
        return {
          canRetry: true,
          errorMessage: `Rate limited or timeout ${status}: ${message}`,
          httpStatus: status,
          isTemporary: true
        };

      case HttpStatusCode.INTERNAL_SERVER_ERROR:
      case HttpStatusCode.BAD_GATEWAY:
      case HttpStatusCode.SERVICE_UNAVAILABLE:
      case HttpStatusCode.GATEWAY_TIMEOUT:
        return {
          canRetry: true,
          errorMessage: `Server error ${status}: ${message}`,
          httpStatus: status,
          isTemporary: true
        };

      default:
        if (status >= 200 && status < 300) {
          return {
            canRetry: false,
            errorMessage: 'Success',
            httpStatus: status,
            isTemporary: false
          };
        }

        if (status >= 400 && status < 500) {
          return {
            canRetry: false,
            errorMessage: `Client error ${status}: ${message}`,
            httpStatus: status,
            isTemporary: false
          };
        }

        if (status >= 500) {
          return {
            canRetry: true,
            errorMessage: `Server error ${status}: ${message}`,
            httpStatus: status,
            isTemporary: true
          };
        }

        return {
          canRetry: false,
          errorMessage: `Unknown status ${status}: ${message}`,
          httpStatus: status,
          isTemporary: false
        };
    }
  }
}
