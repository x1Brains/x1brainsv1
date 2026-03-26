/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/labwork_marketplace.json`.
 */
export type LabworkMarketplace = {
  "address": "CKZHwoUZTJEnGNK4piPxyysrhwLKnnrNoBmEHM9rLaD4",
  "metadata": {
    "name": "labworkMarketplace",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "LabWork NFT Marketplace — list, buy, cancel with fees"
  },
  "instructions": [
    {
      "name": "buyNft",
      "discriminator": [
        96,
        0,
        28,
        190,
        49,
        107,
        83,
        222
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "nftMint"
        },
        {
          "name": "buyerNftAccount",
          "writable": true
        },
        {
          "name": "vaultNftAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "sale.nft_mint",
                "account": "saleAccount"
              },
              {
                "kind": "account",
                "path": "sale.seller",
                "account": "saleAccount"
              }
            ]
          }
        },
        {
          "name": "sale",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  97,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "sale.nft_mint",
                "account": "saleAccount"
              },
              {
                "kind": "account",
                "path": "sale.seller",
                "account": "saleAccount"
              }
            ]
          }
        },
        {
          "name": "sellerWallet",
          "writable": true
        },
        {
          "name": "platformWallet",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "cancelListing",
      "discriminator": [
        41,
        183,
        50,
        232,
        230,
        233,
        157,
        70
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "nftMint"
        },
        {
          "name": "sellerNftAccount",
          "writable": true
        },
        {
          "name": "vaultNftAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "sale.nft_mint",
                "account": "saleAccount"
              },
              {
                "kind": "account",
                "path": "seller"
              }
            ]
          }
        },
        {
          "name": "sale",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  97,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "sale.nft_mint",
                "account": "saleAccount"
              },
              {
                "kind": "account",
                "path": "seller"
              }
            ]
          }
        },
        {
          "name": "platformWallet",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "listNft",
      "discriminator": [
        88,
        221,
        93,
        166,
        63,
        220,
        106,
        232
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "nftMint"
        },
        {
          "name": "sellerNftAccount",
          "writable": true
        },
        {
          "name": "vaultNftAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              },
              {
                "kind": "account",
                "path": "seller"
              }
            ]
          }
        },
        {
          "name": "sale",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  97,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              },
              {
                "kind": "account",
                "path": "seller"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updatePrice",
      "discriminator": [
        61,
        34,
        117,
        155,
        75,
        34,
        123,
        208
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "sale",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  97,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "sale.nft_mint",
                "account": "saleAccount"
              },
              {
                "kind": "account",
                "path": "seller"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newPrice",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "saleAccount",
      "discriminator": [
        213,
        18,
        87,
        228,
        218,
        230,
        207,
        182
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "priceTooLow",
      "msg": "Price is below minimum (0.001 XNT)"
    },
    {
      "code": 6001,
      "name": "notNftOwner",
      "msg": "Caller is not the NFT owner"
    },
    {
      "code": 6002,
      "name": "invalidMint",
      "msg": "Invalid NFT mint"
    },
    {
      "code": 6003,
      "name": "unauthorized",
      "msg": "Caller is not the listing seller"
    },
    {
      "code": 6004,
      "name": "invalidPlatformWallet",
      "msg": "Invalid platform wallet address"
    },
    {
      "code": 6005,
      "name": "invalidSeller",
      "msg": "Invalid seller account"
    },
    {
      "code": 6006,
      "name": "insufficientFunds",
      "msg": "Insufficient funds to purchase NFT"
    },
    {
      "code": 6007,
      "name": "insufficientFundsForCancelFee",
      "msg": "Insufficient funds to pay cancel fee"
    },
    {
      "code": 6008,
      "name": "mathOverflow",
      "msg": "Math overflow"
    }
  ],
  "types": [
    {
      "name": "saleAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "nftMint",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "createdAt",
            "type": "i64"
          }
        ]
      }
    }
  ]
};
