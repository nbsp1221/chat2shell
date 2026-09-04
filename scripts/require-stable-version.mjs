const version = process.argv[2];

if (!version) {
  throw new Error('A version is required');
}

if (version.includes('-')) {
  throw new Error(`Prerelease versions are not supported: ${version}`);
}
