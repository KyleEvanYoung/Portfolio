from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

if __name__ == '__main__':
    print('Serving on http://localhost:8080')
    ThreadingHTTPServer(('0.0.0.0', 8080), SimpleHTTPRequestHandler).serve_forever()
