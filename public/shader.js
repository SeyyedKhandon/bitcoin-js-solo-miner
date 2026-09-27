export const webgpuMinerShader = /*WGSL*/`

struct SHA256_CTX {
    data : array<u32, 64>,
    datalen : u32,
    bitlen : array<u32, 2>,
    state : array<u32, 8>,
    info : u32,
};

@group(0) @binding(0) var<storage, read> headerInput : array<u32>; // 20 u32s (80 bytes)
@group(0) @binding(1) var<storage, read> targetInput : array<u32>; // 8 u32s (32 bytes) target
@group(0) @binding(2) var<storage, read_write> resultNonce : array<atomic<u32>>; // [found_count, nonce1, nonce2, ...]

const SHA256_BLOCK_SIZE = 32;

const k = array<u32, 64> (
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
);

fn ROTLEFT(a : u32, b : u32) -> u32{return (((a) << (b)) | ((a) >> (32-(b))));}
fn ROTRIGHT(a : u32, b : u32) -> u32{return (((a) >> (b)) | ((a) << (32-(b))));}

fn CH(x : u32, y : u32, z : u32) -> u32{return (((x) & (y)) ^ (~(x) & (z)));}
fn MAJ(x : u32, y : u32, z : u32) -> u32{return (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)));}
fn EP0(x : u32) -> u32{return (ROTRIGHT(x,2) ^ ROTRIGHT(x,13) ^ ROTRIGHT(x,22));}
fn EP1(x : u32) -> u32{return (ROTRIGHT(x,6) ^ ROTRIGHT(x,11) ^ ROTRIGHT(x,25));}
fn SIG0(x : u32) -> u32{return (ROTRIGHT(x,7) ^ ROTRIGHT(x,18) ^ ((x) >> 3));}
fn SIG1(x : u32) -> u32{return (ROTRIGHT(x,17) ^ ROTRIGHT(x,19) ^ ((x) >> 10));}

fn sha256_transform(ctx : ptr<function, SHA256_CTX>)
{
var a : u32; var b : u32; var c : u32; var d : u32;
var e : u32; var f : u32; var g : u32; var h : u32;
var i : u32 = 0; var j : u32 = 0;
var t1 : u32; var t2 : u32;
var m : array<u32, 64> ;

while(i < 16) {
    m[i] = ((*ctx).data[j] << 24) | ((*ctx).data[j + 1] << 16) | ((*ctx).data[j + 2] << 8) | ((*ctx).data[j + 3]);
    i++;
    j += 4;
}            

while(i < 64) {
    m[i] = SIG1(m[i - 2]) + m[i - 7] + SIG0(m[i - 15]) + m[i - 16];
    i++;
}

a = (*ctx).state[0]; b = (*ctx).state[1]; c = (*ctx).state[2]; d = (*ctx).state[3];
e = (*ctx).state[4]; f = (*ctx).state[5]; g = (*ctx).state[6]; h = (*ctx).state[7];

i = 0;
for (; i < 64; i++) {
    t1 = h + EP1(e) + CH(e,f,g) + k[i] + m[i];
    t2 = EP0(a) + MAJ(a,b,c);
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
}

(*ctx).state[0] += a; (*ctx).state[1] += b; (*ctx).state[2] += c; (*ctx).state[3] += d;
(*ctx).state[4] += e; (*ctx).state[5] += f; (*ctx).state[6] += g; (*ctx).state[7] += h;
}

fn sha256_update(ctx : ptr<function, SHA256_CTX>, input: array<u32, 80>, len : u32)
{
for (var i :u32 = 0; i < len; i++) {
    (*ctx).data[(*ctx).datalen] = input[i];
    (*ctx).datalen++;
    if ((*ctx).datalen == 64) {
    sha256_transform(ctx);
    
    if ((*ctx).bitlen[0] > 0xffffffff - (512)){
        (*ctx).bitlen[1]++;
    }
    (*ctx).bitlen[0] += 512;
    (*ctx).datalen = 0;
    }
}
}

fn sha256_update_hash(ctx : ptr<function, SHA256_CTX>, input: array<u32, 32>, len : u32)
{
for (var i :u32 = 0; i < len; i++) {
    (*ctx).data[(*ctx).datalen] = input[i];
    (*ctx).datalen++;
    if ((*ctx).datalen == 64) {
    sha256_transform(ctx);
    
    if ((*ctx).bitlen[0] > 0xffffffff - (512)){
        (*ctx).bitlen[1]++;
    }
    (*ctx).bitlen[0] += 512;
    (*ctx).datalen = 0;
    }
}
}

fn sha256_final(ctx : ptr<function, SHA256_CTX>, hash:  ptr<function, array<u32, SHA256_BLOCK_SIZE>>  )
{
var i : u32 = (*ctx).datalen;

if ((*ctx).datalen < 56) {
    (*ctx).data[i] = 0x80;
    i++;
    while (i < 56){
    (*ctx).data[i] = 0x00;
    i++;
    }
}
else {
    (*ctx).data[i] = 0x80;
    i++;
    while (i < 64){
    (*ctx).data[i] = 0x00;
    i++;
    }
    sha256_transform(ctx);
    for (var j = 0; j < 56 ; j++) {
    (*ctx).data[j] = 0;
    }
}

if ((*ctx).bitlen[0] > 0xffffffff - (*ctx).datalen * 8) {
    (*ctx).bitlen[1]++;
}
(*ctx).bitlen[0] += (*ctx).datalen * 8;


(*ctx).data[63] = (*ctx).bitlen[0];
(*ctx).data[62] = (*ctx).bitlen[0] >> 8;
(*ctx).data[61] = (*ctx).bitlen[0] >> 16;
(*ctx).data[60] = (*ctx).bitlen[0] >> 24;
(*ctx).data[59] = (*ctx).bitlen[1];
(*ctx).data[58] = (*ctx).bitlen[1] >> 8;
(*ctx).data[57] = (*ctx).bitlen[1] >> 16;
(*ctx).data[56] = (*ctx).bitlen[1] >> 24;
sha256_transform(ctx);

for (var k = 0; k < 4; k++) {
    (*hash)[k] = ((*ctx).state[0] >> (24 - u32(k) * 8)) & 0x000000ff;
    (*hash)[k + 4] = ((*ctx).state[1] >> (24 - u32(k) * 8)) & 0x000000ff;
    (*hash)[k + 8] = ((*ctx).state[2] >> (24 - u32(k) * 8)) & 0x000000ff;
    (*hash)[k + 12] = ((*ctx).state[3] >> (24 - u32(k) * 8)) & 0x000000ff;
    (*hash)[k + 16] = ((*ctx).state[4] >> (24 - u32(k) * 8)) & 0x000000ff;
    (*hash)[k + 20] = ((*ctx).state[5] >> (24 - u32(k) * 8)) & 0x000000ff;
    (*hash)[k + 24] = ((*ctx).state[6] >> (24 - u32(k) * 8)) & 0x000000ff;
    (*hash)[k + 28] = ((*ctx).state[7] >> (24 - u32(k) * 8)) & 0x000000ff;
}
}

fn init_ctx(ctx : ptr<function, SHA256_CTX>) {
    (*ctx).datalen = 0;
    (*ctx).bitlen[0] = 0;
    (*ctx).bitlen[1] = 0;
    (*ctx).state[0] = 0x6a09e667;
    (*ctx).state[1] = 0xbb67ae85;
    (*ctx).state[2] = 0x3c6ef372;
    (*ctx).state[3] = 0xa54ff53a;
    (*ctx).state[4] = 0x510e527f;
    (*ctx).state[5] = 0x9b05688c;
    (*ctx).state[6] = 0x1f83d9ab;
    (*ctx).state[7] = 0x5be0cd19;
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
    let nonce = global_id.x;

    // Load header (80 bytes) from u32 buffer
    var header : array<u32, 80>;
    for (var i=0u; i < 19u; i++) {
        let word = headerInput[i];
        header[i*4u] = (word) & 0xFFu;
        header[i*4u + 1u] = (word >> 8u) & 0xFFu;
        header[i*4u + 2u] = (word >> 16u) & 0xFFu;
        header[i*4u + 3u] = (word >> 24u) & 0xFFu;
    }
    
    // Add nonce to end of header (byte swapped to LE for header, but shader expects bytes)
    header[76] = (nonce >> 24u) & 0xFFu;
    header[77] = (nonce >> 16u) & 0xFFu;
    header[78] = (nonce >> 8u) & 0xFFu;
    header[79] = (nonce) & 0xFFu;

    // First SHA256
    var ctx1 : SHA256_CTX;
    init_ctx(&ctx1);
    sha256_update(&ctx1, header, 80u);
    var hash1 : array<u32, SHA256_BLOCK_SIZE>;
    sha256_final(&ctx1, &hash1);

    // Second SHA256
    var ctx2 : SHA256_CTX;
    init_ctx(&ctx2);
    sha256_update_hash(&ctx2, hash1, 32u);
    var hash2 : array<u32, SHA256_BLOCK_SIZE>;
    sha256_final(&ctx2, &hash2);

    // Check target (hash2 is little endian in bitcoin, we need to compare it against target array)
    // Bitcoin hashes are compared backwards (hash2[31] is most significant byte)
    // To simplify in WGSL, we just pack hash2 into u32s and compare with targetInput
    
    var meetsTarget = true;
    for (var i : i32 = 7; i >= 0; i--) {
        let hWord = (hash2[u32(i)*4u + 3u] << 24u) | (hash2[u32(i)*4u + 2u] << 16u) | (hash2[u32(i)*4u + 1u] << 8u) | hash2[u32(i)*4u];
        let tWord = targetInput[u32(i)];
        
        if (hWord > tWord) {
            meetsTarget = false;
            break;
        } else if (hWord < tWord) {
            break;
        }
    }

    if (meetsTarget) {
        // Increment found count and append nonce
        let idx = atomicAdd(&resultNonce[0], 1u);
        if (idx < 255u) {
            atomicStore(&resultNonce[idx + 1u], nonce);
        }
    }
}
`;
