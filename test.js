import { bech32m } from 'bech32'; 

function decodeScriptPubKeyToTaprootAddress(scriptPubKey, network = 'mainnet') {
  if (!scriptPubKey.startsWith('5120') || scriptPubKey.length !== 68) {
    throw new Error('Invalid P2TR ScriptPubKey');
  }

  // Extract the 32-byte public key (after '5120')
  const pubkeyHex = scriptPubKey.slice(4);
  const pubkeyBytes = Buffer.from(pubkeyHex, 'hex');

  // Determine the HRP (Human-Readable Part) based on the network
  const hrp = network === 'mainnet' ? 'bc' : 'tb';

  // Convert bytes to 5-bit groups (Bech32m)
  const pubkeyBits = bech32m.toWords(pubkeyBytes);
  
  // Create the address with a version 1 witness program
  const address = bech32m.encode(hrp, [1].concat(pubkeyBits));
  
  return address;
}

// Example usage
const scriptPubKeyP2TR = '5120821715b2c62e8f492326077b05f401e854fca2674c7312d2cf695535787d0016';

const address = decodeScriptPubKeyToTaprootAddress(scriptPubKeyP2TR, 'testnet');
console.log('Taproot Address:', address);

// tb1psgt3tvkx9685jgexqaastaqpap20egn8f3e395k0d92n27raqqtqpknljl
// tb1psgt3tvkx9685jgexqaastaqpap20egn8f3e395k0d92n27raqqtq52rnha
// tb1psgt3tvkx9685jgexqaastaqpap20egn8f3e395k0d92n27raqqtqpknljl
// aaa
// aaa