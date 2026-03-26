/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/labwork_marketplace.json`.
 */
export type LabworkMarketplace = {
  "address": "EQKNXSBE6vUbtPBY1ibXPyWmLzrtXBZqUs9Fjqo19TkX",
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
          "name": "nftMint",
          "docs": [
            "NFT mint — for PDA seed derivation"
          ]
        },
        {
          "name": "buyerTokenAccount",
          "docs": [
            "Buyer's token account to receive the NFT"
          ],
          "writable": true
        },
        {
          "name": "escrowTokenAccount",
          "docs": [
            "Escrow token account holding the NFT"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "listing.nft_mint",
                "account": "listingAccount"
              }
            ]
          }
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "Authority PDA for the escrow"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "listing.nft_mint",
                "account": "listingAccount"
              }
            ]
          }
        },
        {
          "name": "listing",
          "docs": [
            "Listing account — closed on purchase, rent returned to seller"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "listing.nft_mint",
                "account": "listingAccount"
              }
            ]
          }
        },
        {
          "name": "sellerWallet",
          "docs": [
            "Seller wallet to receive proceeds (and listing account rent)"
          ],
          "writable": true
        },
        {
          "name": "platformWallet",
          "docs": [
            "Platform fee wallet"
          ],
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
      "name": "delistNft",
      "discriminator": [
        91,
        249,
        165,
        185,
        22,
        7,
        119,
        176
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "nftMint",
          "docs": [
            "NFT mint — needed for PDA seed derivation"
          ]
        },
        {
          "name": "sellerTokenAccount",
          "docs": [
            "Seller's token account to receive the NFT back"
          ],
          "writable": true
        },
        {
          "name": "escrowTokenAccount",
          "docs": [
            "Escrow token account holding the NFT"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "listing.nft_mint",
                "account": "listingAccount"
              }
            ]
          }
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "Authority PDA for the escrow"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "listing.nft_mint",
                "account": "listingAccount"
              }
            ]
          }
        },
        {
          "name": "listing",
          "docs": [
            "Listing account — closed on delist, rent returned to seller"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "listing.nft_mint",
                "account": "listingAccount"
              }
            ]
          }
        },
        {
          "name": "platformWallet",
          "docs": [
            "Platform fee wallet receives the cancel fee"
          ],
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
          "name": "nftMint",
          "docs": [
            "NFT mint address"
          ]
        },
        {
          "name": "sellerTokenAccount",
          "docs": [
            "Seller's token account holding the NFT (must have balance=1)"
          ],
          "writable": true
        },
        {
          "name": "escrowTokenAccount",
          "docs": [
            "PDA token account that holds the NFT in escrow while listed"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          }
        },
        {
          "name": "escrowAuthority",
          "docs": [
            "Authority PDA for the escrow token account"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
              }
            ]
          }
        },
        {
          "name": "listing",
          "docs": [
            "Listing state account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "nftMint"
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
          "name": "listing",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "listing.nft_mint",
                "account": "listingAccount"
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
      "name": "listingAccount",
      "discriminator": [
        59,
        89,
        136,
        25,
        21,
        196,
        183,
        13
      ]
    }
  ],
  "events": [
    {
      "name": "listingCancelled",
      "discriminator": [
        11,
        46,
        163,
        10,
        103,
        80,
        139,
        194
      ]
    },
    {
      "name": "listingCreated",
      "discriminator": [
        94,
        164,
        167,
        255,
        246,
        186,
        12,
        96
      ]
    },
    {
      "name": "nftSold",
      "discriminator": [
        131,
        159,
        14,
        234,
        148,
        57,
        117,
        37
      ]
    },
    {
      "name": "priceUpdated",
      "discriminator": [
        154,
        72,
        87,
        150,
        246,
        230,
        23,
        217
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
      "name": "unauthorized",
      "msg": "Caller is not the listing seller"
    },
    {
      "code": 6003,
      "name": "invalidPlatformWallet",
      "msg": "Invalid platform wallet address"
    },
    {
      "code": 6004,
      "name": "invalidSeller",
      "msg": "Invalid seller account"
    },
    {
      "code": 6005,
      "name": "insufficientFunds",
      "msg": "Insufficient funds to purchase NFT"
    },
    {
      "code": 6006,
      "name": "insufficientFundsForCancelFee",
      "msg": "Insufficient funds to pay cancel fee"
    },
    {
      "code": 6007,
      "name": "mathOverflow",
      "msg": "Math overflow in fee calculation"
    }
  ],
  "types": [
    {
      "name": "listingAccount",
      "docs": [
        "On-chain record for a single NFT listing"
      ],
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
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "escrowBump",
            "type": "u8"
          },
          {
            "name": "escrowAuthBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "listingCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "nftMint",
            "type": "pubkey"
          },
          {
            "name": "cancelFee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "listingCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listing",
            "type": "pubkey"
          },
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
            "name": "createdAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "nftSold",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "buyer",
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
            "name": "platformFee",
            "type": "u64"
          },
          {
            "name": "sellerProceeds",
            "type": "u64"
          },
          {
            "name": "soldAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "priceUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "nftMint",
            "type": "pubkey"
          },
          {
            "name": "oldPrice",
            "type": "u64"
          },
          {
            "name": "newPrice",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
