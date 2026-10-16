The self-signed certificate and private key are public test fixtures for page.test.
They have no production use. The certificate expires in October 2036. Tests trust
it only in a child process through NODE_EXTRA_CA_CERTS.
